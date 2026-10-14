// Accesso ai dati. Due implementazioni con la stessa interfaccia:
//  - supabaseBackend: database e accesso con link via email su Supabase
//  - demoBackend: tutto in memoria (si perde ricaricando la pagina)

export async function createBackend(url, key) {
  const demo = new URLSearchParams(location.search).has('demo');
  return url && key && !demo ? supabaseBackend(url, key) : demoBackend();
}

const NOT_ALLOWED = 'Operazione non consentita: il tuo indirizzo non è tra i familiari abilitati.';

async function supabaseBackend(url, key) {
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm');
  const sb = createClient(url, key);
  const check = ({ data, error }) => {
    if (error) throw error;
    return data;
  };
  // Se le regole di sicurezza bloccano la scrittura, Supabase non dà errore ma 0 righe.
  const one = (rows) => {
    if (!rows.length) throw new Error(NOT_ALLOWED);
    return rows[0];
  };

  return {
    mode: 'supabase',

    async getUser() {
      const { data } = await sb.auth.getSession();
      return data.session?.user ?? null;
    },
    onAuthChange(cb) {
      // Il callback viene rimandato: chiamare Supabase dentro onAuthStateChange può bloccarsi.
      sb.auth.onAuthStateChange((_event, session) => setTimeout(() => cb(session?.user ?? null)));
    },
    // Solo per utenti già creati dal proprietario: niente registrazioni libere.
    async sendLink(email) {
      check(await sb.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: false, emailRedirectTo: location.origin + location.pathname },
      }));
    },
    async verifyCode(email, token) {
      check(await sb.auth.verifyOtp({ email, token, type: 'email' }));
    },
    async signOut() {
      await sb.auth.signOut();
    },

    async loadAll() {
      const [members, settings, tasks, entries] = await Promise.all([
        sb.from('members').select('*'),
        sb.from('settings').select('*').maybeSingle(),
        sb.from('tasks').select('*'),
        sb.from('entries').select('*').order('at', { ascending: false }).limit(3000),
      ]);
      return {
        members: check(members),
        settings: check(settings) ?? {},
        tasks: check(tasks),
        entries: check(entries),
      };
    },

    async addEntry(entry) {
      return check(await sb.from('entries').insert(entry).select().single());
    },
    async deleteEntry(id) {
      one(check(await sb.from('entries').delete().eq('id', id).select()));
    },

    async saveTask(id, task) {
      const q = id ? sb.from('tasks').update(task).eq('id', id) : sb.from('tasks').insert(task);
      return one(check(await q.select()));
    },
    async deleteTask(id) {
      one(check(await sb.from('tasks').delete().eq('id', id).select()));
    },
    async taskDone(id) {
      return check(await sb.rpc('task_done', { p_task: id }));
    },

    async saveSettings(patch) {
      return one(check(await sb.from('settings').update(patch).eq('id', true).select()));
    },
  };
}

// ---------------------------------------------------------------- Modalità demo

async function demoBackend() {
  const user = { id: 'demo', email: 'demo@esempio.it' };
  const clone = (x) => structuredClone(x);
  const now = () => new Date().toISOString();
  const daysAgo = (d, hour = 19) => {
    const date = new Date();
    date.setDate(date.getDate() - d);
    date.setHours(hour, 0, 0, 0);
    return date.toISOString();
  };
  const base = () => ({ id: crypto.randomUUID(), created_by: user.email, created_at: now(), note: '' });

  const members = [{ email: user.email, display_name: 'Utente demo' }];
  // Nessun intervallo predefinito, come nell'app vera: si provano da "Impostazioni".
  let settings = { id: true, volume_l: null };
  for (const k of ['bromo', 'ph', 'alk']) Object.assign(settings, { [`${k}_min`]: null, [`${k}_max`]: null, [`${k}_low`]: '', [`${k}_high`]: '' });

  const task = (name, every_days, lastDays, notes = '') => ({
    id: crypto.randomUUID(), name, every_days, notes, gcal_event_id: null, created_at: now(),
    last_done: lastDays == null ? null : daysAgo(lastDays, 10),
  });
  let tasks = [
    task('Controllo acqua', 2, 3, 'Misurare bromo, pH e alcalinità con lo Scuba3s.'),
    task('Lavaggio filtro', 7, 5, 'Sciacquare la cartuccia con un getto d\'acqua e lasciarla asciugare.'),
    task('Cambio acqua', 90, 80),
    task('Pulizia copertura', 30, null),
  ];

  // Valori di esempio: servono solo a vedere grafici e storico.
  const samples = [[20, 4.5, 7.6, 110], [17, 3.2, 7.8, 105], [14, 2.1, 7.5, 100], [11, 5.8, 7.3, 95],
    [8, 4.0, 7.2, 90], [6, 3.6, 7.4, 100], [3, 1.4, 7.9, 95], [1, 3.9, 7.5, 100]];
  let entries = samples.map(([d, bromo, ph, alk]) => ({ ...base(), type: 'misura', at: daysAgo(d), bromo, ph, alk }));
  entries.push({ ...base(), type: 'trattamento', at: daysAgo(3, 20), product: 'Pastiglie di bromo', qty: 2, unit: 'pastiglie' });
  entries.push({ ...base(), type: 'trattamento', at: daysAgo(3, 20), product: 'pH minus', qty: 15, unit: 'g', note: 'pH alto dopo la misura' });
  for (const t of tasks.filter((t) => t.last_done)) {
    entries.push({ ...base(), type: 'attivita', at: t.last_done, task_id: t.id, task_name: t.name, prev_last_done: null });
  }
  const sortEntries = () => entries.sort((a, b) => b.at.localeCompare(a.at));
  sortEntries();

  return {
    mode: 'demo',
    async getUser() { return user; },
    onAuthChange() {},
    async sendLink() {},
    async verifyCode() {},
    async signOut() { location.reload(); },

    async loadAll() {
      return clone({ members, settings, tasks, entries });
    },
    async addEntry(entry) {
      const row = { ...base(), ...entry };
      entries.push(row);
      sortEntries();
      return clone(row);
    },
    async deleteEntry(id) {
      const old = entries.find((e) => e.id === id);
      entries = entries.filter((e) => e.id !== id);
      // Come il trigger del database: annulla l'ultima esecuzione di un'attività.
      const t = old?.type === 'attivita' && tasks.find((x) => x.id === old.task_id);
      if (t && t.last_done === old.at) {
        const rest = entries.filter((e) => e.type === 'attivita' && e.task_id === t.id).map((e) => e.at);
        t.last_done = [...rest, old.prev_last_done].filter(Boolean).sort().pop() ?? null;
      }
    },
    async saveTask(id, patch) {
      if (id) {
        const t = tasks.find((x) => x.id === id);
        Object.assign(t, patch);
        return clone(t);
      }
      const t = { id: crypto.randomUUID(), gcal_event_id: null, created_at: now(), notes: '', last_done: null, ...patch };
      tasks.push(t);
      return clone(t);
    },
    async deleteTask(id) {
      tasks = tasks.filter((t) => t.id !== id);
      for (const e of entries) if (e.task_id === id) e.task_id = null;
    },
    async taskDone(id) {
      const t = tasks.find((x) => x.id === id);
      const at = now();
      entries.push({ ...base(), type: 'attivita', at, task_id: t.id, task_name: t.name, prev_last_done: t.last_done });
      sortEntries();
      t.last_done = at;
      return clone(t);
    },
    async saveSettings(patch) {
      settings = { ...settings, ...patch };
      return clone(settings);
    },
  };
}
