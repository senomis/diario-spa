-- Diario SPA – schema del database (Supabase / Postgres).
-- Da eseguire una volta sola nel SQL Editor del progetto Supabase (New query → incolla → Run).
--
-- Accesso ai dati: solo gli utenti autenticati la cui email è nella tabella "members".
-- Per aggiungere un familiare (oltre a crearlo in Authentication → Users):
--   insert into public.members (email, display_name) values ('nome@esempio.it', 'Nome');

-- ---------------------------------------------------------------- Familiari abilitati

create table public.members (
  email        text primary key check (email = lower(email)),
  display_name text not null
);

-- Vero se chi chiama è nell'elenco. "security definer" perché deve leggere "members"
-- anche quando le regole di sicurezza di "members" dipendono da questa stessa funzione.
create function public.is_member() returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.members where email = lower(auth.jwt() ->> 'email'))
$$;
revoke execute on function public.is_member() from public, anon;
grant execute on function public.is_member() to authenticated;

-- Email di chi sta scrivendo, usata come autore delle registrazioni.
create function public.current_email() returns text
language sql stable set search_path = ''
as $$ select lower(auth.jwt() ->> 'email') $$;

-- ---------------------------------------------------------------- Impostazioni (una riga sola)

-- Nessun valore predefinito per intervalli e indicazioni: li inserisce il proprietario,
-- presi dal manuale della SPA e dalle etichette dei prodotti.
create table public.settings (
  id         boolean primary key default true check (id),
  volume_l   numeric check (volume_l > 0),
  bromo_min  numeric,
  bromo_max  numeric,
  bromo_low  text not null default '',
  bromo_high text not null default '',
  ph_min     numeric,
  ph_max     numeric,
  ph_low     text not null default '',
  ph_high    text not null default '',
  alk_min    numeric,
  alk_max    numeric,
  alk_low    text not null default '',
  alk_high   text not null default '',
  check (bromo_min is null or bromo_max is null or bromo_min <= bromo_max),
  check (ph_min is null or ph_max is null or ph_min <= ph_max),
  check (alk_min is null or alk_max is null or alk_min <= alk_max)
);
insert into public.settings default values;

-- ---------------------------------------------------------------- Attività periodiche

create table public.tasks (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (btrim(name) <> ''),
  every_days    integer not null check (every_days > 0),
  notes         text not null default '',
  last_done     timestamptz,
  gcal_event_id text,  -- evento Google Calendar della prossima scadenza (Edge Function)
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------- Registro

create table public.entries (
  id             uuid primary key default gen_random_uuid(),
  type           text not null check (type in ('misura', 'attivita', 'trattamento')),
  at             timestamptz not null default now(),
  -- misura (valori letti sul fotometro)
  bromo          numeric check (bromo >= 0),      -- mg/l Br2
  ph             numeric check (ph between 0 and 14),
  alk            numeric check (alk >= 0),        -- mg/l CaCO3
  -- attività eseguita: il nome resta anche se l'attività viene eliminata
  task_id        uuid references public.tasks (id) on delete set null,
  task_name      text,
  prev_last_done timestamptz,  -- ultima esecuzione precedente, per annullare un "Fatto"
  -- prodotto aggiunto
  product        text,
  qty            numeric,
  unit           text check (unit in ('g', 'ml', 'pastiglie', 'misurini')),
  note           text not null default '',
  created_by     text not null default public.current_email(),
  created_at     timestamptz not null default now(),
  check (
    (type = 'misura' and coalesce(bromo, ph, alk) is not null)
    or (type = 'attivita' and task_name is not null)
    or (type = 'trattamento' and btrim(product) <> '' and qty > 0 and unit is not null)
  )
);
create index entries_at_idx on public.entries (at desc);
create index entries_task_idx on public.entries (task_id) where type = 'attivita';

-- "Fatto": registra l'esecuzione e aggiorna l'ultima esecuzione in un'unica operazione.
create function public.task_done(p_task uuid) returns public.tasks
language plpgsql set search_path = ''
as $$
declare
  t public.tasks;
begin
  select * into t from public.tasks where id = p_task for update;
  if not found then
    raise exception 'Attività non trovata';
  end if;
  insert into public.entries (type, at, task_id, task_name, prev_last_done)
  values ('attivita', now(), t.id, t.name, t.last_done);
  update public.tasks set last_done = now() where id = t.id returning * into t;
  return t;
end
$$;
revoke execute on function public.task_done(uuid) from public, anon;
grant execute on function public.task_done(uuid) to authenticated;

-- Se si elimina dallo storico l'esecuzione più recente di un'attività, l'ultima
-- esecuzione torna a quella precedente (così si annulla un "Fatto" premuto per sbaglio).
create function public.entries_after_delete() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if old.type = 'attivita' and old.task_id is not null then
    update public.tasks
    set last_done = greatest(
      (select max(e.at) from public.entries e where e.task_id = old.task_id and e.type = 'attivita'),
      old.prev_last_done)
    where id = old.task_id and last_done = old.at;
  end if;
  return null;
end
$$;
create trigger entries_after_delete after delete on public.entries
for each row execute function public.entries_after_delete();

-- ---------------------------------------------------------------- Regole di sicurezza (RLS)

-- Permessi espliciti per l'API (i progetti recenti potrebbero non darli in automatico);
-- chi vede cosa lo decidono comunque le regole RLS qui sotto.
revoke all on public.members, public.settings, public.tasks, public.entries from anon;
grant select on public.members to authenticated;
grant select, update on public.settings to authenticated;
grant select, insert, update, delete on public.tasks to authenticated;
grant select, insert, delete on public.entries to authenticated;

alter table public.members  enable row level security;
alter table public.settings enable row level security;
alter table public.tasks    enable row level security;
alter table public.entries  enable row level security;

-- L'elenco dei familiari si modifica solo dal SQL Editor / Table Editor.
create policy members_read on public.members for select to authenticated using (public.is_member());

create policy settings_read   on public.settings for select to authenticated using (public.is_member());
create policy settings_update on public.settings for update to authenticated
  using (public.is_member()) with check (public.is_member());

create policy tasks_all on public.tasks for all to authenticated
  using (public.is_member()) with check (public.is_member());

-- Le registrazioni non si modificano: si eliminano e si reinseriscono.
create policy entries_read   on public.entries for select to authenticated using (public.is_member());
create policy entries_insert on public.entries for insert to authenticated
  with check (public.is_member() and created_by = public.current_email());
create policy entries_delete on public.entries for delete to authenticated using (public.is_member());
