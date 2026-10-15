# Diario SPA

Web app per gestire una minipiscina SPA domestica trattata a bromo: registro delle misure
dell'acqua, dei prodotti aggiunti e delle attività periodiche di manutenzione.
Pensata per lo smartphone, in italiano, usata dal proprietario e da alcuni familiari.

- **Oggi**: ultimi valori di bromo, pH e alcalinità con lo stato rispetto all'intervallo
  obiettivo, indicazioni da seguire quando un valore è fuori intervallo, attività in scadenza
  (entro 7 giorni) o in ritardo.
- **Registra**: misura (valori letti sul fotometro Lovibond Scuba3s) e prodotto aggiunto,
  con suggerimenti dai prodotti già usati.
- **Attività**: attività periodiche con frequenza in giorni e istruzioni. “Fatto” registra
  l'esecuzione e sposta la scadenza. Eliminando dallo storico l'esecuzione più recente,
  la scadenza torna a quella precedente (per annullare un “Fatto” premuto per sbaglio).
- **Storico**: grafico per parametro con la fascia dell'intervallo obiettivo e i punti fuori
  intervallo in rosso; registro cronologico con autore ed eliminazione delle voci.
- **Opzioni**: volume della vasca e, per ogni parametro, minimo, massimo e cosa fare se è
  basso o alto. Nel codice non c'è nessun valore predefinito: vanno presi dal manuale della
  SPA e dalle etichette dei prodotti.

Guida per chi usa l'app: [`guida.html`](guida.html).

## Architettura (tutta gratuita)

| Parte | Servizio |
|---|---|
| Sito (HTML/JS statico, senza build) | GitHub Pages |
| Database | Supabase – Postgres, con regole di sicurezza (RLS) |
| Accesso | Supabase – Auth (email + password, utenti creati dal proprietario) |
| Promemoria | Google Calendar, aggiornato da uno script Google Apps Script |

Il progetto Supabase gratuito **va in pausa dopo 7 giorni senza utilizzo** (si riattiva con un
clic dalla dashboard; i dati non si perdono).

## Provarla subito (modalità demo)

Con `js/config.js` non compilato l'app parte in modalità demo, con dati di esempio in memoria.
Serve un piccolo server locale:

```powershell
powershell -ExecutionPolicy Bypass -File serve.ps1 -Port 8081
```

poi apri <http://localhost:8081>. Con `?demo` nell'indirizzo si usa la demo anche con Supabase
configurato.

## Installazione

### 1. Progetto Supabase e database

1. Su <https://supabase.com> crea un **nuovo progetto** (regione *Central EU*), separato da
   quello di Canti per la messa.
2. **SQL Editor → New query**: incolla [`supabase/schema.sql`](supabase/schema.sql) e premi
   **Run**. Crea tabelle, regole di sicurezza e la riga delle impostazioni (vuota).

### 2. Chiudi le registrazioni

**Authentication → Sign In / Providers → Email**: lascia attivo il provider Email ma
**disattiva “Allow new users to sign up”**. Così possono entrare solo gli utenti creati da te.

### 3. Familiari abilitati

Per ogni persona servono **due** passi:

1. **Authentication → Users → Add user → Create new user**: email e password, spunta
   *Auto Confirm User*. Comunica la password all'interessato, che potrà cambiarla dall'app
   (“Password” in alto).
2. **SQL Editor**:

   ```sql
   insert into public.members (email, display_name) values ('nome@esempio.it', 'Nome');
   ```

   L'email va scritta **in minuscolo**. Chi ha un utente ma non è in `members` entra nell'app
   ma vede solo il messaggio “Accesso non abilitato”, e il database non gli restituisce nulla.

Per togliere l'accesso: elimina la riga da `members` (e l'utente da *Authentication → Users*).

### 4. Collega l'app a Supabase

In **Project Settings → API** (o *API Keys*) copia il *Project URL* e la chiave pubblica
(*anon* / *publishable*) in [`js/config.js`](js/config.js). La chiave pubblica può stare nel
sito: i dati sono protetti dalle regole RLS. **Mai** usare la chiave *service_role* / *secret*.

### 5. Pubblica su GitHub Pages

Repository `senomis/diario-spa` → **Settings → Pages** → *Deploy from a branch*, `main`,
cartella `/ (root)`. Dopo un minuto l'app è su <https://senomis.github.io/diario-spa/>.

## Note

- **Accesso**: resta attivo sul telefono finché non si preme “Esci”. Se qualcuno dimentica la
  password, impostane una nuova da *Authentication → Users* (menu dell'utente).
- **Aggiornamenti dell'app**: a ogni modifica di JS o CSS aggiorna il `?v=` negli indirizzi
  (`index.html`, `guida.html` e gli `import` in `js/app.js`), altrimenti i telefoni possono
  tenere in cache i file vecchi.
- **Dati condivisi**: l'app ricarica i dati quando la si riapre; le modifiche fatte da un
  familiare si vedono tornando sull'app.

## Google Calendar

Per ogni attività c'è un evento di un giorno intero alla prossima scadenza nel calendario Google
“SPA”. Lo gestisce lo script [`google-apps-script/Calendario.gs`](google-apps-script/Calendario.gs),
che gira gratis nell'account Google del proprietario ogni 15 minuti: legge le attività dal
database, crea o sposta gli eventi e toglie quelli delle attività eliminate (l'ID dell'evento
finisce in `tasks.gcal_event_id`). Dopo un “Fatto” l'evento si sposta quindi entro un quarto
d'ora. Un'attività mai eseguita compare nel giorno corrente finché non viene fatta.

Scelto al posto di service account + Edge Function: niente Google Cloud Console né chiavi da
custodire, e gli eventi creati dal proprietario fanno arrivare le notifiche del calendario a
tutti gli iscritti.

### Installazione

**1. Calendario.** In Google Calendar (dal computer): *Altri calendari* → **+** → *Crea nuovo
calendario*, nome `SPA`. Poi nelle sue impostazioni:
- *Condividi con persone specifiche*: aggiungi i familiari con “Apportare modifiche agli eventi”
  (o solo “Visualizzare tutti i dettagli” se non devono toccare il calendario);
- *Integra calendario* → copia l'**ID calendario** (`…@group.calendar.google.com`).

**2. Utente per lo script.** In Supabase crea un utente dedicato (*Authentication → Users →
Add user*, *Auto Confirm User*), per esempio con la tua email aggiungendo `+calendario` prima
della `@`, e una password lunga. Poi abilitalo:

```sql
insert into public.members (email, display_name) values ('tuonome+calendario@esempio.it', 'Calendario');
```

**3. Script.** Su <https://script.google.com> (con l'account proprietario del calendario):
1. *Nuovo progetto*, rinominalo `Diario SPA – Calendario`.
2. Sostituisci il contenuto di `Codice.gs` con quello di
   [`google-apps-script/Calendario.gs`](google-apps-script/Calendario.gs) e salva.
3. *Impostazioni progetto* (ingranaggio): fuso orario **(GMT+01:00) Ora dell'Europa centrale –
   Roma**; in fondo, *Proprietà script* → aggiungi `SUPABASE_URL`, `SUPABASE_KEY` (la chiave
   *publishable*), `SUPABASE_EMAIL`, `SUPABASE_PASSWORD` (dell'utente del passo 2) e `CALENDAR_ID`.
4. Torna nell'editor, scegli la funzione **`installa`** ed esegui. La prima volta Google chiede
   l'autorizzazione (calendario, servizi esterni, esecuzione automatica): conferma. Se compare
   “Google non ha verificato questa app”, è normale per uno script tuo: *Avanzate* → *Vai a …*.
5. Controlla che nel calendario “SPA” compaiano gli eventi `SPA: <attività>`.

`installa` attiva l'esecuzione ogni 15 minuti (*Attivatori*, l'icona della sveglia). Se lo
script si blocca (per esempio password cambiata), Google ti manda un'email con l'errore.

**4. Notifiche.** I promemoria sono quelli impostati da ciascuno sul calendario “SPA”: in Google
Calendar → impostazioni del calendario “SPA” → *Notifiche per eventi che durano tutto il giorno*
(per esempio “Il giorno stesso alle 9:00”). Ogni familiare lo imposta per sé, anche dall'app
Google Calendar del telefono.

## Possibili sviluppi

- Importazione delle misure dal CSV esportato da Lovibond PoolAssistant.
- Calcolo delle dosi in base al volume della vasca, con regole definite per ciascun prodotto.
