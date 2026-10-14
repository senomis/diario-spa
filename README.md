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
| Accesso | Supabase – Auth, link o codice via email (niente password) |
| Promemoria | Google Calendar tramite Supabase Edge Function (*da fare*) |

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

### 2. Accesso

1. **Authentication → Sign In / Providers → Email**: lascia attivo il provider Email e
   **disattiva “Allow new users to sign up”**. Così il link arriva solo agli utenti creati da te.
2. **Authentication → URL Configuration**:
   - *Site URL*: `https://senomis.github.io/diario-spa/`
   - *Redirect URLs*: aggiungi `https://senomis.github.io/diario-spa/` e, per le prove in locale,
     `http://localhost:8081/`.
3. **Authentication → Emails → Magic Link**: perché l'email contenga anche il **codice** (utile
   sull'iPhone se l'app è aggiunta alla schermata Home, dove il link si aprirebbe in Safari),
   sostituisci il testo con qualcosa come:

   ```html
   <h2>Accesso a Diario SPA</h2>
   <p><a href="{{ .ConfirmationURL }}">Entra nel diario</a></p>
   <p>Oppure scrivi questo codice nell'app: <b>{{ .Token }}</b></p>
   ```

   Oggetto, per esempio: `Accesso a Diario SPA`.

### 3. Familiari abilitati

Per ogni persona servono **due** passi:

1. **Authentication → Users → Add user → Create new user**: email, spunta *Auto Confirm User*.
   La password non viene usata dall'app.
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

- **Email di accesso**: il servizio email incluso in Supabase ha un limite molto basso di
  messaggi l'ora. Va bene per pochi familiari, perché l'accesso resta attivo sul telefono
  finché non si preme “Esci”. Se diventa scomodo, imposta un SMTP proprio in
  *Authentication → Emails → SMTP Settings*.
- **Aggiornamenti dell'app**: a ogni modifica di JS o CSS aggiorna il `?v=` negli indirizzi
  (`index.html`, `guida.html` e gli `import` in `js/app.js`), altrimenti i telefoni possono
  tenere in cache i file vecchi.
- **Dati condivisi**: l'app ricarica i dati quando la si riapre; le modifiche fatte da un
  familiare si vedono tornando sull'app.

## Google Calendar (prossimo passo)

Previsto: un calendario Google dedicato (“SPA”) condiviso con un service account; una Edge
Function crea o aggiorna per ogni attività un evento alla prossima scadenza, salvandone l'ID in
`tasks.gcal_event_id`. La chiave del service account starà solo nei *secrets* di Supabase,
impostata dal proprietario: mai nel sito, nel repository o nelle conversazioni.

## Possibili sviluppi

- Importazione delle misure dal CSV esportato da Lovibond PoolAssistant.
- Calcolo delle dosi in base al volume della vasca, con regole definite per ciascun prodotto.
