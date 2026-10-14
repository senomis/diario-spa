import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js?v=2026.10.14';
import { createBackend } from './backend.js?v=2026.10.14';

// ---------------------------------------------------------------- Costanti e utilità

const PARAMS = [
  { key: 'bromo', name: 'Bromo', unit: 'mg/l Br₂', digits: 1 },
  { key: 'ph', name: 'pH', unit: '', digits: 1 },
  { key: 'alk', name: 'Alcalinità', unit: 'mg/l CaCO₃', digits: 0 },
];
const UNITS = ['g', 'ml', 'pastiglie', 'misurini'];
const TABS = [['oggi', 'Oggi'], ['registra', 'Registra'], ['attivita', 'Attività'], ['storico', 'Storico'], ['impostazioni', 'Opzioni']];
const TASK_IDEAS = ['Controllo acqua', 'Lavaggio filtro', 'Sostituzione filtro', 'Cambio acqua', 'Pulizia copertura', 'Pulizia linea di galleggiamento'];
const STATUS_LABEL = { ok: 'Nell\'intervallo', low: 'Basso', high: 'Alto' };
const SOON_DAYS = 7;       // "in scadenza" su Oggi
const CHART_POINTS = 60;   // misure mostrate nei grafici
const LOG_PAGE = 100;      // voci del registro mostrate alla volta
const DAY = 86_400_000;

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Numero da un campo di testo: accetta la virgola. null se vuoto, NaN se non valido.
function num(v) {
  const s = String(v ?? '').trim().replace(',', '.');
  return s === '' ? null : (/^-?\d*\.?\d+$/.test(s) ? Number(s) : NaN);
}
// Senza separatore delle migliaia: "1.500" verrebbe riletto come 1,5 nei campi.
const fmtNum = (v, digits = 2) => (v == null ? '' : Number(v).toLocaleString('it-IT', { maximumFractionDigits: digits, useGrouping: false }));
const pad = (n) => String(n).padStart(2, '0');
const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localDateTime = (d) => `${localDay(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
function fmtDate(iso, withTime = false) {
  if (!iso) return '—';
  const d = new Date(iso);
  const day = d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  return withTime ? `${day}, ${d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}` : day;
}
const days = (n) => `${n} ${n === 1 ? 'giorno' : 'giorni'}`;

function errorText(e) {
  const msg = e?.message || String(e);
  if (e?.code === '42501') return 'Operazione non consentita: il tuo indirizzo non è tra i familiari abilitati.';
  if (e?.code === '23514') return 'Dati non validi: controlla i valori inseriti.';
  if (/failed to fetch|networkerror|load failed/i.test(msg)) return 'Connessione assente: riprova tra poco.';
  return msg;
}
function authErrorText(e) {
  const msg = e?.message || String(e);
  if (/invalid login credentials/i.test(msg)) return 'Email o password non corretti.';
  if (e?.status === 429 || /rate limit/i.test(msg)) return 'Troppi tentativi: riprova tra qualche minuto.';
  if (/should be different/i.test(msg)) return 'La nuova password deve essere diversa da quella attuale.';
  if (/password should be at least/i.test(msg)) return 'La password è troppo corta.';
  return errorText(e);
}

let toastTimer;
function toast(msg, kind = 'ok') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, kind === 'error' ? 6000 : 2500);
}

// ---------------------------------------------------------------- Stato

const state = {
  backend: null,
  user: null,
  loaded: false,
  members: [],
  settings: {},
  tasks: [],
  entries: [],     // dalla più recente
  tab: 'oggi',
  editTaskId: null,
  logLimit: LOG_PAGE,
  dirty: false,    // un modulo della vista è in corso di compilazione
};

const myEmail = () => state.user?.email?.toLowerCase() ?? '';
const isMember = () => state.members.some((m) => m.email === myEmail());
const memberName = (email) => state.members.find((m) => m.email === email)?.display_name ?? email ?? '';

function range(k) {
  const s = state.settings;
  return { min: s[`${k}_min`] ?? null, max: s[`${k}_max`] ?? null, low: s[`${k}_low`] ?? '', high: s[`${k}_high`] ?? '' };
}
function status(k, v) {
  if (v == null) return '';
  const r = range(k);
  if (r.min == null && r.max == null) return '';
  if (r.min != null && v < r.min) return 'low';
  if (r.max != null && v > r.max) return 'high';
  return 'ok';
}
const outOfRange = (k, v) => ['low', 'high'].includes(status(k, v));
function rangeText(r) {
  if (r.min != null && r.max != null) return `Obiettivo ${fmtNum(r.min)}–${fmtNum(r.max)}`;
  if (r.min != null) return `Obiettivo ≥ ${fmtNum(r.min)}`;
  if (r.max != null) return `Obiettivo ≤ ${fmtNum(r.max)}`;
  return 'Intervallo non impostato';
}
function latest(k) {
  const e = state.entries.find((x) => x.type === 'misura' && x[k] != null);
  return e ? { v: e[k], at: e.at } : null;
}

// Scadenza: giorno dell'ultima esecuzione + frequenza, confrontata a giorni interi.
function dueInfo(t) {
  if (!t.last_done) return { days: -Infinity, due: null, label: 'Mai eseguita', cls: 'late' };
  const last = new Date(t.last_done);
  const due = new Date(last.getFullYear(), last.getMonth(), last.getDate() + t.every_days);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const n = Math.round((due - today) / DAY);
  const label = n < 0 ? `In ritardo di ${days(-n)}` : n === 0 ? 'Da fare oggi' : n === 1 ? 'Da fare domani' : `Tra ${days(n)}`;
  return { days: n, due, label, cls: n <= 0 ? 'late' : n <= 2 ? 'soon' : '' };
}
const byDue = (a, b) => dueInfo(a).days - dueInfo(b).days || a.name.localeCompare(b.name, 'it');

// ---------------------------------------------------------------- Viste

function vOggi() {
  const gauges = PARAMS.map((p) => {
    const l = latest(p.key);
    const st = l ? status(p.key, l.v) : '';
    return `<div class="gauge ${st === 'ok' ? 'ok' : st ? 'bad' : ''}">
      <div class="n">${p.name}</div>
      <div class="v">${l ? fmtNum(l.v) : '—'}</div>
      ${st ? `<div class="s">${STATUS_LABEL[st]}</div>` : ''}
      <div class="r">${l ? fmtDate(l.at) : 'Nessuna misura'}<br>${rangeText(range(p.key))}</div>
    </div>`;
  }).join('');

  const advice = PARAMS.map((p) => {
    const l = latest(p.key);
    const st = l && status(p.key, l.v);
    if (st !== 'low' && st !== 'high') return '';
    const text = range(p.key)[st];
    return `<div class="advice"><b>${p.name} ${st === 'low' ? 'sotto' : 'sopra'} l'intervallo (${fmtNum(l.v)}${p.unit ? ' ' + p.unit : ''}).</b>
${text ? esc(text) : 'Nessuna indicazione impostata: aggiungila in Opzioni.'}</div>`;
  }).join('');

  const sorted = [...state.tasks].sort(byDue);
  const due = sorted.filter((t) => dueInfo(t).days <= SOON_DAYS);
  let tasks;
  if (due.length) tasks = due.map((t) => taskRow(t)).join('');
  else if (sorted.length) tasks = `<p class="empty">Niente in scadenza nei prossimi ${SOON_DAYS} giorni. Prossima: <b>${esc(sorted[0].name)}</b>, ${dueInfo(sorted[0]).label.toLowerCase()}.</p>`;
  else tasks = `<p class="empty">Nessuna attività ancora. <button class="ghost" data-go="attivita">Crea la prima</button></p>`;

  const vol = state.settings.volume_l;
  return `<h1>Oggi</h1>
  <p class="sub">${vol ? `Vasca da ${fmtNum(vol)} litri` : '<button class="linkish" data-go="impostazioni">Imposta volume e intervalli</button>'}</p>
  <h2>Ultimi valori</h2>
  <div class="gauges">${gauges}</div>${advice}
  <div class="actions"><button data-go="registra">Registra misura</button><button class="ghost" data-go="registra" data-focus="t_prod">Registra prodotto</button></div>
  <h2>Attività in scadenza</h2>
  <div class="stack">${tasks}</div>
  ${state.tasks.length > due.length && due.length ? '<p><button class="ghost" data-go="attivita">Tutte le attività</button></p>' : ''}`;
}

function taskRow(t, { editable = false } = {}) {
  const d = dueInfo(t);
  const when = [d.label, `ogni ${days(t.every_days)}`, t.last_done ? `ultima ${fmtDate(t.last_done)}` : ''].filter(Boolean).join(' · ');
  return `<div class="task ${d.cls}">
    <span class="dot" aria-hidden="true"></span>
    <div class="t"><b>${esc(t.name)}</b><span>${when}</span>
      ${t.notes ? `<details><summary>Istruzioni</summary><p>${esc(t.notes)}</p></details>` : ''}</div>
    ${editable ? `<button class="ghost" data-edit="${t.id}">Modifica</button>` : ''}
    <button data-done="${t.id}">Fatto</button>
  </div>`;
}

function vRegistra() {
  const products = [...new Set(state.entries.filter((e) => e.type === 'trattamento').map((e) => e.product))];
  const now = localDateTime(new Date());
  return `<h1>Registra</h1>
  <p class="sub">I valori letti sul fotometro Scuba3s o un prodotto aggiunto.</p>
  <h2>Misura</h2>
  <form class="panel" id="f-misura" autocomplete="off">
    <div class="row3">
      ${PARAMS.map((p) => `<div><label for="m_${p.key}">${p.name}${p.unit ? ` <span class="unit">${p.unit}</span>` : ''}</label>
        <input id="m_${p.key}" name="${p.key}" inputmode="decimal"></div>`).join('')}
    </div>
    <div class="field"><label for="m_at">Data e ora</label><input type="datetime-local" id="m_at" name="at" value="${now}" required></div>
    <div class="field"><label for="m_note">Note</label><input id="m_note" name="note" placeholder="Facoltative"></div>
    <div class="actions"><button type="submit">Salva misura</button></div>
  </form>
  <h2>Prodotto aggiunto</h2>
  <form class="panel" id="f-prodotto" autocomplete="off">
    <div><label for="t_prod">Prodotto</label><input id="t_prod" name="product" list="products" required>
      <datalist id="products">${products.map((p) => `<option value="${esc(p)}">`).join('')}</datalist></div>
    <div class="row field">
      <div><label for="t_qty">Quantità</label><input id="t_qty" name="qty" inputmode="decimal" required></div>
      <div><label for="t_unit">Unità</label><select id="t_unit" name="unit">${UNITS.map((u) => `<option>${u}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label for="t_at">Data e ora</label><input type="datetime-local" id="t_at" name="at" value="${now}" required></div>
    <div class="field"><label for="t_note">Note</label><input id="t_note" name="note" placeholder="Es. pH alto dopo la misura di ieri"></div>
    <div class="actions"><button type="submit">Salva prodotto</button></div>
  </form>`;
}

function vAttivita() {
  const t = state.tasks.find((x) => x.id === state.editTaskId);
  const list = [...state.tasks].sort(byDue);
  return `<h1>Attività</h1>
  <p class="sub">Le attività periodiche di manutenzione e la loro frequenza.</p>
  <div class="stack">${list.length ? list.map((x) => taskRow(x, { editable: true })).join('') : '<p class="empty">Nessuna attività. Creane una qui sotto.</p>'}</div>
  <h2 id="task-form-title">${t ? 'Modifica attività' : 'Nuova attività'}</h2>
  <form class="panel" id="f-task" autocomplete="off">
    ${t ? '' : `<p class="note top">Idee: ${TASK_IDEAS.map((s) => `<button type="button" class="chip" data-idea="${esc(s)}">${esc(s)}</button>`).join('')}</p>`}
    <div><label for="k_name">Nome</label><input id="k_name" name="name" required value="${esc(t?.name)}"></div>
    <div class="row field">
      <div><label for="k_every">Ogni quanti giorni</label><input id="k_every" name="every_days" inputmode="numeric" required value="${esc(t?.every_days)}"></div>
      <div><label for="k_last">Ultima esecuzione</label><input type="date" id="k_last" name="last_done" value="${t?.last_done ? localDay(new Date(t.last_done)) : ''}"></div>
    </div>
    <div class="field"><label for="k_notes">Istruzioni</label><textarea id="k_notes" name="notes" placeholder="Es. sciacquare con un getto d'acqua, lasciare asciugare">${esc(t?.notes)}</textarea></div>
    <div class="actions">
      <button type="submit">${t ? 'Salva modifiche' : 'Crea attività'}</button>
      ${t ? '<button type="button" class="ghost" id="btn-cancel-edit">Annulla</button><button type="button" class="danger" id="btn-delete-task">Elimina</button>' : ''}
    </div>
  </form>`;
}

function chart(p) {
  const pts = state.entries.filter((e) => e.type === 'misura' && e[p.key] != null).slice(0, CHART_POINTS).reverse();
  if (pts.length < 2) return '<p class="empty">Servono almeno due misure per il grafico.</p>';
  const r = range(p.key);
  const vals = pts.map((e) => e[p.key]);
  let lo = Math.min(...vals, r.min ?? Infinity);
  let hi = Math.max(...vals, r.max ?? -Infinity);
  if (hi === lo) { hi += 1; lo -= 1; }
  const padY = (hi - lo) * 0.1;
  lo -= padY;
  hi += padY;
  const W = 400, H = 180, L = 38, R = 8, T = 10, B = 24;
  const t0 = new Date(pts[0].at).getTime();
  const t1 = new Date(pts[pts.length - 1].at).getTime();
  const x = (at) => L + (W - L - R) * ((new Date(at).getTime() - t0) / Math.max(1, t1 - t0));
  const y = (v) => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  const band = r.min != null || r.max != null
    ? `<rect x="${L}" width="${W - L - R}" y="${y(r.max ?? hi)}" height="${Math.max(0, y(r.min ?? lo) - y(r.max ?? hi))}" fill="var(--band)"/>`
    : '';
  const path = pts.map((e, i) => `${i ? 'L' : 'M'}${x(e.at).toFixed(1)} ${y(e[p.key]).toFixed(1)}`).join(' ');
  const dots = pts.map((e) => {
    const bad = outOfRange(p.key, e[p.key]);
    return `<circle cx="${x(e.at).toFixed(1)}" cy="${y(e[p.key]).toFixed(1)}" r="${bad ? 5 : 4}" fill="${bad ? 'var(--bad)' : 'var(--accent)'}"><title>${fmtDate(e.at, true)}: ${fmtNum(e[p.key])}</title></circle>`;
  }).join('');
  const ticks = [lo + padY, (lo + hi) / 2, hi - padY].map((v) => `<text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" font-size="12" fill="var(--muted)">${fmtNum(v, p.digits)}</text>`).join('');
  const outCount = vals.filter((v) => outOfRange(p.key, v)).length;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Andamento ${p.name}: ${pts.length} misure, ${outCount} fuori intervallo">
    ${band}${ticks}
    <path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2"/>${dots}
    <text x="${L}" y="${H - 6}" font-size="12" fill="var(--muted)">${fmtDate(pts[0].at)}</text>
    <text x="${W - R}" y="${H - 6}" text-anchor="end" font-size="12" fill="var(--muted)">${fmtDate(pts[pts.length - 1].at)}</text>
  </svg>
  <p class="note">${rangeText(r)} · ${outCount ? `${outCount} ${outCount === 1 ? 'misura' : 'misure'} fuori intervallo` : 'nessuna misura fuori intervallo'}</p>`;
}

function describe(e) {
  if (e.type === 'misura') {
    return PARAMS.filter((p) => e[p.key] != null)
      .map((p) => `${p.name} <b class="${outOfRange(p.key, e[p.key]) ? 'out' : ''}">${fmtNum(e[p.key])}</b>`).join(', ');
  }
  if (e.type === 'attivita') return `<b>${esc(e.task_name)}</b> eseguita`;
  return `Aggiunto <b>${esc(e.product)}</b>: ${fmtNum(e.qty)} ${esc(e.unit)}`;
}

function vStorico() {
  const shown = state.entries.slice(0, state.logLimit);
  const log = shown.map((e) => `<li>
    <span class="when">${fmtDate(e.at, true)}</span>
    <span class="what">${describe(e)}${e.note ? `<br><span class="note">${esc(e.note)}</span>` : ''}<br><span class="note">${esc(memberName(e.created_by))}</span></span>
    <button class="ghost small" data-del="${e.id}" aria-label="Elimina la voce del ${fmtDate(e.at, true)}">Elimina</button>
  </li>`).join('');
  return `<h1>Storico</h1>
  <p class="sub">La fascia verde è l'intervallo obiettivo, i punti rossi sono fuori intervallo. Ultime ${CHART_POINTS} misure.</p>
  ${PARAMS.map((p) => `<h2>${p.name}${p.unit ? ` <span class="unit">${p.unit}</span>` : ''}</h2><div class="panel">${chart(p)}</div>`).join('')}
  <h2>Registro</h2>
  <div class="panel">${shown.length ? `<ul class="log">${log}</ul>` : '<p class="empty">Ancora nessuna registrazione.</p>'}
  ${state.entries.length > shown.length ? '<div class="actions"><button class="ghost" id="btn-more">Mostra altre</button></div>' : ''}</div>`;
}

function vImpostazioni() {
  const s = state.settings;
  return `<h1>Opzioni</h1>
  <p class="sub">Intervalli e indicazioni vanno presi dal manuale della SPA e dalle etichette dei prodotti.</p>
  <form id="f-settings" autocomplete="off">
    <h2>Vasca</h2>
    <div class="panel"><label for="s_vol">Volume (litri)</label><input id="s_vol" name="volume_l" inputmode="decimal" value="${esc(fmtNum(s.volume_l))}"></div>
    ${PARAMS.map((p) => {
      const r = range(p.key);
      return `<h2>${p.name}${p.unit ? ` <span class="unit">${p.unit}</span>` : ''}</h2><div class="panel">
        <div class="row">
          <div><label for="s_${p.key}_min">Minimo</label><input id="s_${p.key}_min" name="${p.key}_min" inputmode="decimal" value="${esc(fmtNum(r.min))}"></div>
          <div><label for="s_${p.key}_max">Massimo</label><input id="s_${p.key}_max" name="${p.key}_max" inputmode="decimal" value="${esc(fmtNum(r.max))}"></div>
        </div>
        <div class="field"><label for="s_${p.key}_low">Cosa fare se è basso</label><textarea id="s_${p.key}_low" name="${p.key}_low">${esc(r.low)}</textarea></div>
        <div class="field"><label for="s_${p.key}_high">Cosa fare se è alto</label><textarea id="s_${p.key}_high" name="${p.key}_high">${esc(r.high)}</textarea></div>
      </div>`;
    }).join('')}
    <div class="actions"><button type="submit">Salva impostazioni</button></div>
  </form>`;
}

function vNonAbilitato() {
  return `<h1>Accesso non abilitato</h1>
  <div class="panel"><p>L'indirizzo <b>${esc(myEmail())}</b> non è nell'elenco dei familiari abilitati a vedere il diario.</p>
  <p>Chiedi al proprietario di aggiungerlo, poi ricarica la pagina.</p>
  <div class="actions"><button id="btn-reload">Ricarica</button></div></div>`;
}

const VIEWS = { oggi: vOggi, registra: vRegistra, attivita: vAttivita, storico: vStorico, impostazioni: vImpostazioni };

// Con force=false (aggiornamento in background) non si cancella un modulo in compilazione.
function render({ force = true } = {}) {
  if (!state.loaded) return;
  const allowed = isMember();
  $('#nav').hidden = !allowed;
  $('#who').textContent = allowed ? memberName(myEmail()) : myEmail();
  $('#nav-in').innerHTML = TABS.map(([k, label]) => `<button data-tab="${k}" ${state.tab === k ? 'aria-current="page"' : ''}>${label}</button>`).join('');
  if (!force && state.dirty) return;
  state.dirty = false;
  $('#view').innerHTML = allowed ? VIEWS[state.tab]() : vNonAbilitato();
}

function go(tab) {
  state.tab = tab;
  state.editTaskId = null;
  state.logLimit = LOG_PAGE;
  render();
  window.scrollTo(0, 0);
}

async function refresh({ force = true } = {}) {
  try {
    Object.assign(state, await state.backend.loadAll());
    state.loaded = true;
  } catch (e) {
    toast(errorText(e), 'error');
  }
  render({ force });
}

// Esegue una scrittura, ricarica i dati e mostra l'esito.
async function act(btn, fn, okMsg) {
  if (btn) btn.disabled = true;
  try {
    await fn();
  } catch (e) {
    toast(errorText(e), 'error');
    if (btn) btn.disabled = false;
    return false;
  }
  await refresh();
  if (okMsg) toast(okMsg);
  return true;
}

// ---------------------------------------------------------------- Eventi

document.addEventListener('input', (e) => {
  if (e.target.closest('#view form')) state.dirty = true;
});

$('#view').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;

  if (b.dataset.go) {
    go(b.dataset.go);
    document.getElementById(b.dataset.focus ?? 'm_bromo')?.focus();
    return;
  }
  if (b.dataset.idea) {
    $('#k_name').value = b.dataset.idea;
    state.dirty = true;
    $('#k_every').focus();
    return;
  }
  if (b.dataset.done) {
    const t = state.tasks.find((x) => x.id === b.dataset.done);
    if (t) await act(b, () => state.backend.taskDone(t.id), `${t.name}: registrata`);
    return;
  }
  if (b.dataset.edit) {
    state.editTaskId = b.dataset.edit;
    render();
    $('#task-form-title').scrollIntoView({ behavior: 'smooth' });
    $('#k_name').focus({ preventScroll: true });
    return;
  }
  if (b.id === 'btn-cancel-edit') {
    state.editTaskId = null;
    render();
    return;
  }
  if (b.id === 'btn-delete-task') {
    const t = state.tasks.find((x) => x.id === state.editTaskId);
    if (!t || !confirm(`Eliminare l'attività "${t.name}"? Le esecuzioni passate restano nello storico.`)) return;
    if (await act(b, () => state.backend.deleteTask(t.id), 'Attività eliminata')) {
      state.editTaskId = null;
      render();
    }
    return;
  }
  if (b.dataset.del) {
    const entry = state.entries.find((x) => x.id === b.dataset.del);
    const extra = entry?.type === 'attivita' ? '\nSe è l\'esecuzione più recente, la scadenza dell\'attività torna a quella precedente.' : '';
    if (confirm(`Eliminare questa registrazione?${extra}`)) await act(b, () => state.backend.deleteEntry(b.dataset.del), 'Registrazione eliminata');
    return;
  }
  if (b.id === 'btn-more') {
    state.logLimit += LOG_PAGE;
    render();
    return;
  }
  if (b.id === 'btn-reload') location.reload();
});

// Valida un campo numerico facoltativo; segnala l'errore e restituisce undefined se non valido.
function readNumber(form, name, label, { min = -Infinity, max = Infinity } = {}) {
  const v = num(form.elements[name].value);
  if (Number.isNaN(v) || (v != null && (v < min || v > max))) {
    toast(`${label}: valore non valido`, 'error');
    form.elements[name].focus();
    return undefined;
  }
  return v;
}
const isoFrom = (local) => new Date(local).toISOString();

$('#view').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const btn = f.querySelector('button[type=submit]');
  const text = (name) => f.elements[name].value.trim();

  if (f.id === 'f-misura') {
    const entry = { type: 'misura', at: isoFrom(f.elements.at.value), note: text('note') };
    for (const p of PARAMS) {
      const v = readNumber(f, p.key, p.name, { min: 0, max: p.key === 'ph' ? 14 : Infinity });
      if (v === undefined) return;
      entry[p.key] = v;
    }
    if (PARAMS.every((p) => entry[p.key] == null)) {
      toast('Inserisci almeno un valore', 'error');
      return;
    }
    if (await act(btn, () => state.backend.addEntry(entry), 'Misura salvata')) go('oggi');
    return;
  }

  if (f.id === 'f-prodotto') {
    const qty = readNumber(f, 'qty', 'Quantità', { min: Number.MIN_VALUE });
    if (qty == null) {
      if (qty === null) toast('Indica la quantità', 'error');
      return;
    }
    const entry = { type: 'trattamento', product: text('product'), qty, unit: f.elements.unit.value, at: isoFrom(f.elements.at.value), note: text('note') };
    await act(btn, () => state.backend.addEntry(entry), 'Prodotto registrato');
    return;
  }

  if (f.id === 'f-task') {
    const every = Number(text('every_days'));
    if (!Number.isInteger(every) || every < 1) {
      toast('Indica ogni quanti giorni (numero intero)', 'error');
      return;
    }
    const last = f.elements.last_done.value;
    const id = state.editTaskId;
    const task = { name: text('name'), every_days: every, notes: text('notes'), last_done: last ? isoFrom(`${last}T12:00`) : null };
    // Se la data non è cambiata si conserva l'ora esatta dell'ultimo "Fatto".
    const old = state.tasks.find((x) => x.id === id);
    if (old?.last_done && last === localDay(new Date(old.last_done))) task.last_done = old.last_done;
    if (await act(btn, () => state.backend.saveTask(id, task), id ? 'Attività aggiornata' : 'Attività creata')) {
      state.editTaskId = null;
      render();
    }
    return;
  }

  if (f.id === 'f-settings') {
    const patch = {};
    const vol = readNumber(f, 'volume_l', 'Volume', { min: Number.MIN_VALUE });
    if (vol === undefined) return;
    patch.volume_l = vol;
    for (const p of PARAMS) {
      const min = readNumber(f, `${p.key}_min`, `${p.name} minimo`);
      const max = readNumber(f, `${p.key}_max`, `${p.name} massimo`);
      if (min === undefined || max === undefined) return;
      if (min != null && max != null && min > max) {
        toast(`${p.name}: il minimo supera il massimo`, 'error');
        return;
      }
      Object.assign(patch, { [`${p.key}_min`]: min, [`${p.key}_max`]: max, [`${p.key}_low`]: text(`${p.key}_low`), [`${p.key}_high`]: text(`${p.key}_high`) });
    }
    await act(btn, () => state.backend.saveSettings(patch), 'Impostazioni salvate');
  }
});

$('#nav').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) go(b.dataset.tab);
});

// I dati possono essere cambiati da un familiare: si ricaricano quando si torna sull'app.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.user && state.loaded) refresh({ force: false });
});

// ---------------------------------------------------------------- Accesso

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const btn = f.querySelector('button');
  $('#login-error').textContent = '';
  btn.disabled = true;
  try {
    await state.backend.signIn(f.elements.email.value.trim(), f.elements.password.value);
    f.elements.password.value = '';
  } catch (err) {
    $('#login-error').textContent = authErrorText(err);
  } finally {
    btn.disabled = false;
  }
});

$('#btn-password').addEventListener('click', () => {
  $('#password-form').reset();
  $('#password-error').textContent = '';
  $('#password-dialog').showModal();
});
$('#btn-password-cancel').addEventListener('click', () => $('#password-dialog').close());

$('#password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  if (f.elements.pw1.value !== f.elements.pw2.value) {
    $('#password-error').textContent = 'Le due password non coincidono.';
    return;
  }
  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    await state.backend.changePassword(f.elements.pw1.value);
    $('#password-dialog').close();
    toast('Password aggiornata');
  } catch (err) {
    $('#password-error').textContent = authErrorText(err);
  } finally {
    btn.disabled = false;
  }
});

$('#btn-logout').addEventListener('click', async () => {
  await state.backend.signOut();
});

async function showFor(user) {
  state.user = user;
  $('#boot').hidden = true;
  $('#login-view').hidden = !!user;
  $('#app-view').hidden = !user;
  if (!user) {
    state.loaded = false;
    $('#login-error').textContent = '';
    return;
  }
  await refresh();
}

async function boot() {
  state.backend = await createBackend(SUPABASE_URL, SUPABASE_ANON_KEY);
  $('#demo-banner').hidden = state.backend.mode !== 'demo';
  $('#btn-password').hidden = state.backend.mode === 'demo';
  state.backend.onAuthChange((user) => {
    if ((user?.id ?? null) !== (state.user?.id ?? null)) showFor(user);
  });
  await showFor(await state.backend.getUser());
}

boot().catch((e) => {
  $('#boot').textContent = `Errore di avvio: ${errorText(e)}`;
});
