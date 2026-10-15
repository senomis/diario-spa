// Diario SPA → Google Calendar (Google Apps Script)
//
// Per ogni attività del diario tiene nel calendario "SPA" un evento di un giorno intero alla
// prossima scadenza: dopo un "Fatto" l'evento si sposta alla nuova data, alla prossima
// esecuzione dello script (ogni 15 minuti). Gli eventi di attività eliminate vengono tolti.
// Lo script tocca solo gli eventi che ha creato lui (riconosciuti da un'etichetta nascosta).
//
// Proprietà da impostare in Impostazioni progetto → Proprietà script:
//   SUPABASE_URL       https://xxxxxxxx.supabase.co
//   SUPABASE_KEY       chiave pubblica "publishable" (sb_publishable_...)
//   SUPABASE_EMAIL     utente Supabase dedicato al calendario, presente in "members"
//   SUPABASE_PASSWORD  la sua password
//   CALENDAR_ID        ID del calendario "SPA" (Impostazioni del calendario → Integra calendario)
//
// Prima volta: eseguire "installa" (attiva l'esecuzione automatica ogni 15 minuti).

const APP_URL = 'https://senomis.github.io/diario-spa/';
const TAG = 'diarioSpaTaskId';
const TITLE_PREFIX = 'SPA: ';

function installa() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'sincronizza')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('sincronizza').timeBased().everyMinutes(15).create();
  sincronizza();
}

function sincronizza() {
  // Evita due esecuzioni sovrapposte (eventi doppi).
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    sincronizza_();
  } finally {
    lock.releaseLock();
  }
}

function sincronizza_() {
  const p = PropertiesService.getScriptProperties().getProperties();
  for (const k of ['SUPABASE_URL', 'SUPABASE_KEY', 'SUPABASE_EMAIL', 'SUPABASE_PASSWORD', 'CALENDAR_ID']) {
    if (!p[k]) throw new Error(`Manca la proprietà dello script ${k}`);
  }
  const cal = CalendarApp.getCalendarById(p.CALENDAR_ID);
  if (!cal) throw new Error('Calendario non trovato: controlla CALENDAR_ID');
  const db = supabase_(p);

  // Se l'utente non fosse abilitato il database restituirebbe zero attività e lo script
  // cancellerebbe tutti gli eventi: meglio fermarsi.
  const me = db.get(`members?select=email&email=eq.${encodeURIComponent(p.SUPABASE_EMAIL.toLowerCase())}`);
  if (!me.length) throw new Error(`${p.SUPABASE_EMAIL} non è nella tabella members`);
  const tasks = db.get('tasks?select=id,name,every_days,notes,last_done,gcal_event_id');

  // Eventi creati da questo script, raggruppati per attività.
  const from = new Date();
  from.setFullYear(from.getFullYear() - 2);
  const to = new Date();
  to.setFullYear(to.getFullYear() + 5);
  const byTask = {};
  for (const ev of cal.getEvents(from, to)) {
    const id = ev.getTag(TAG);
    if (id) (byTask[id] = byTask[id] || []).push(ev);
  }

  for (const t of tasks) {
    const due = dueDate_(t);
    const title = TITLE_PREFIX + t.name;
    const desc = [t.notes, `Ogni ${t.every_days} giorni. Quando l'hai fatta premi "Fatto" nel diario: ${APP_URL}`]
      .filter(Boolean).join('\n\n');
    const [found, ...duplicates] = byTask[t.id] || [];
    duplicates.forEach((ev) => ev.deleteEvent());
    let ev = found;
    if (!ev) {
      ev = cal.createAllDayEvent(title, due, { description: desc });
      ev.setTag(TAG, t.id);
    } else {
      if (ev.getTitle() !== title) ev.setTitle(title);
      if (ev.getDescription() !== desc) ev.setDescription(desc);
      if (day_(ev.getAllDayStartDate()) !== day_(due)) ev.setAllDayDate(due);
    }
    if (t.gcal_event_id !== ev.getId()) db.patch(`tasks?id=eq.${t.id}`, { gcal_event_id: ev.getId() });
    delete byTask[t.id];
  }

  // Attività eliminate dal diario.
  Object.keys(byTask).forEach((id) => byTask[id].forEach((ev) => ev.deleteEvent()));
}

// Prossima scadenza: giorno dell'ultima esecuzione + frequenza.
// Un'attività mai eseguita va in calendario oggi (e ci resta finché non si preme "Fatto").
function dueDate_(t) {
  if (!t.last_done) return parseDay_(day_(new Date()));
  const last = parseDay_(day_(new Date(t.last_done)));
  last.setDate(last.getDate() + t.every_days);
  return last;
}

const day_ = (date) => Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
function parseDay_(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// Accesso al database con l'utente dedicato: valgono le stesse regole di sicurezza dell'app.
function supabase_(p) {
  const base = p.SUPABASE_URL.replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
  const login = UrlFetchApp.fetch(`${base}/auth/v1/token?grant_type=password`, {
    method: 'post',
    contentType: 'application/json',
    headers: { apikey: p.SUPABASE_KEY },
    payload: JSON.stringify({ email: p.SUPABASE_EMAIL, password: p.SUPABASE_PASSWORD }),
    muteHttpExceptions: true,
  });
  if (login.getResponseCode() !== 200) {
    throw new Error(`Accesso a Supabase non riuscito (${login.getResponseCode()}): ${login.getContentText()}`);
  }
  const token = JSON.parse(login.getContentText()).access_token;

  const call = (method, path, body) => {
    const options = {
      method,
      headers: { apikey: p.SUPABASE_KEY, Authorization: `Bearer ${token}` },
      muteHttpExceptions: true,
    };
    if (body) {
      options.contentType = 'application/json';
      options.payload = JSON.stringify(body);
    }
    const res = UrlFetchApp.fetch(`${base}/rest/v1/${path}`, options);
    if (res.getResponseCode() >= 300) {
      throw new Error(`Errore del database (${res.getResponseCode()}) su ${path}: ${res.getContentText()}`);
    }
    const text = res.getContentText();
    return text ? JSON.parse(text) : null;
  };
  return {
    get: (path) => call('get', path),
    patch: (path, body) => call('patch', path, body),
  };
}
