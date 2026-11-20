-- Hopper schema snapshot, taken from the live database (project "stromata", schema hopper)
-- on 18 Nov 2026. A reference copy, not a migration: the live database was built with
-- migrations applied through the Supabase connector. Regenerate when the schema changes.
-- Changes after this snapshot are in supabase/migrations/ (from 20261118214500_hopper_anchor_filing_v1:
-- anchor columns on note_projects, tag_rejections, project cut-offs, scoring and filing functions).
-- Also 20261119080000_hopper_design_sweep: settings.auto_design, hopper.design_sweep() and the
-- hopper-design-sweep cron job (10, 30 and 50 past each hour; two images a run since 20261119083000).
-- 20261118231745_hopper_bin_seven_days (notes.deleted_at, notes_for_ai and note_cards skip or carry it,
-- file_note skips binned notes, hopper.bin_tick() and the hopper-bin cron job at 04:41).
-- 20261119110000_hopper_capture_token (settings.capture_token_sha256; token in Vault).
-- And 20261119090000_hopper_aesthetic_vocabulary (hopper.aesthetics, hopper.aesthetic_aliases,
-- hopper.canonical_aesthetics) and 20261119093000_hopper_mcp_token (settings.mcp_token_sha256; token in Vault).
-- 20261120134438_hopper_benchmark_pages: page context columns on attachments and note_links, and
-- hopper.benchmark_scores (columns below are current as of 20 Nov 2026).
-- 20261120190000_hopper_moves: hopper.moves (visual move vocabulary) and attachments.moves.
--
-- Extensions used (in schema extensions): vector, pg_net, pg_cron.
-- Grants: every table and view here has access revoked from public, anon and authenticated.
-- Only the edge functions (service role) read and write them.

create schema if not exists hopper;

create table hopper.notes (
  id uuid not null default gen_random_uuid(),
  source text not null default 'app'::text,
  keep_file text,
  title text,
  body text,
  list_items jsonb,
  created_at timestamp with time zone not null default now(),
  edited_at timestamp with time zone,
  archived boolean not null default false,
  pinned boolean not null default false,
  keep_labels text[] not null default '{}'::text[],
  keep_color text,
  format text,
  period text,
  summary text,
  confidence text,
  is_locked boolean not null default false,
  lock_source text,
  lock_reason text,
  cull_candidate boolean not null default false,
  tagged_at timestamp with time zone,
  tagger_model text,
  reviewed boolean not null default false,
  inserted_at timestamp with time zone not null default now(),
  aesthetics text[] not null default '{}'::text[],
  why_saved text,
  anti_reference boolean not null default false,
  constraint notes_pkey primary key (id),
  constraint notes_keep_file_key unique (keep_file),
  constraint notes_confidence_check check (confidence in ('high','medium','low')),
  constraint notes_format_check check (format in ('quote','note','bookmark','list','image','scratch','reference','component')),
  constraint notes_lock_source_check check (lock_source in ('user','pattern','classifier','review')),
  constraint notes_source_check check (source in ('keep-import','app','assistant','blog'))
);

create table hopper.attachments (
  id uuid not null default gen_random_uuid(),
  note_id uuid not null references hopper.notes(id) on delete cascade,
  original_file text,
  storage_path text,
  thumbnail_path text,
  mime text,
  width integer,
  height integer,
  caption text,
  text_in_image text,
  design_read jsonb,
  image_role text,                        -- first-screen-1440, first-screen-390, full-page or figure
  source_page_url text,                   -- the page the image was captured from
  caption_on_page text,
  rendered_width_at_1440 integer,
  rendered_height_at_1440 integer,
  position_from_top_px_at_1440 integer,
  captured_on date,
  moves text[] not null default '{}'::text[],  -- visual moves from hopper.moves, set by hopper-design
  constraint attachments_pkey primary key (id),
  constraint attachments_image_role_check check (image_role in ('first-screen-1440','first-screen-390','full-page','figure')),
  constraint attachments_note_id_original_file_key unique (note_id, original_file)
);

create table hopper.note_links (
  id uuid not null default gen_random_uuid(),
  note_id uuid not null references hopper.notes(id) on delete cascade,
  url text not null,
  kind text not null default 'article'::text,
  provider text,
  media_id text,
  page_title text,
  page_text text,
  thumbnail_url text,
  creator text,
  duration_seconds integer,
  transcript text,
  saved_copy_path text,
  fetched_at timestamp with time zone,
  is_dead boolean,
  fetch_status text,
  page_height_px_at_1440 integer,
  videos_on_page integer,
  captured_on date,
  layout_read jsonb,                      -- the page read as layout: first-screen UI share, widest figure, image treatment, motion
  constraint note_links_pkey primary key (id),
  constraint note_links_note_id_url_key unique (note_id, url),
  constraint note_links_fetch_status_check check (fetch_status in ('ok','dead','blocked','private','timeout','error','skipped')),
  constraint note_links_kind_check check (kind in ('article','video','audio','image','product','pdf','social','other'))
);

create table hopper.note_embeddings (
  note_id uuid not null primary key references hopper.notes(id) on delete cascade,
  embedding extensions.vector(384) not null,
  model text not null default 'gte-small'::text,
  created_at timestamp with time zone not null default now()
);

create table hopper.projects (
  id uuid not null default gen_random_uuid() primary key,
  name text not null unique,
  description text,
  tells text,
  is_live boolean not null default true
);

create table hopper.topics (
  id uuid not null default gen_random_uuid() primary key,
  name text not null unique
);

create table hopper.people (
  id uuid not null default gen_random_uuid() primary key,
  name text not null unique,
  aliases text[] not null default '{}'::text[],
  period text
);

create table hopper.works (
  id uuid not null default gen_random_uuid() primary key,
  title text not null,
  person_id uuid references hopper.people(id) on delete set null,
  constraint works_title_person_id_key unique (title, person_id)
);

create table hopper.note_projects (
  note_id uuid not null references hopper.notes(id) on delete cascade,
  project_id uuid not null references hopper.projects(id) on delete cascade,
  confidence text check (confidence in ('high','medium','low')),
  confirmed boolean not null default false,
  primary key (note_id, project_id)
);

create table hopper.note_topics (
  note_id uuid not null references hopper.notes(id) on delete cascade,
  topic_id uuid not null references hopper.topics(id) on delete cascade,
  confidence text check (confidence in ('high','medium','low')),
  confirmed boolean not null default false,
  primary key (note_id, topic_id)
);

create table hopper.note_people (
  note_id uuid not null references hopper.notes(id) on delete cascade,
  person_id uuid not null references hopper.people(id) on delete cascade,
  role text not null default 'author'::text check (role in ('author','subject')),
  confidence text check (confidence in ('high','medium','low')),
  confirmed boolean not null default false,
  primary key (note_id, person_id, role)
);

create table hopper.note_works (
  note_id uuid not null references hopper.notes(id) on delete cascade,
  work_id uuid not null references hopper.works(id) on delete cascade,
  confidence text check (confidence in ('high','medium','low')),
  confirmed boolean not null default false,
  primary key (note_id, work_id)
);

-- Visual moves: what an image does as design (annotated-screen, component-collage...). Add a term once it turns up twice.
create table hopper.moves (
  name text primary key,
  description text not null,
  added_on date not null default current_date
);
alter table hopper.moves enable row level security;

-- Portfolio benchmark scores, copied from Notion's "Portfolio Benchmarks" (the source of truth; formulas stay there).
create table hopper.benchmark_scores (
  note_id uuid primary key references hopper.notes(id) on delete cascade,
  name text not null,
  site_url text not null,
  scores_source text not null,           -- the Notion row
  status text not null check (status in ('Reviewed', 'To review')),
  rank_overall integer,                   -- among scored benchmarks, Keith's own row excluded; ties share a rank
  overall numeric(3,2),
  substance numeric(3,2),
  presentation numeric(3,2),
  visual_quality smallint check (visual_quality between 1 and 5),
  shell_craft smallint check (shell_craft between 1 and 5),
  work_legibility smallint check (work_legibility between 1 and 5),
  contribution_clarity smallint check (contribution_clarity between 1 and 5),
  leadership_evidence smallint check (leadership_evidence between 1 and 5),
  outcome_evidence smallint check (outcome_evidence between 1 and 5),
  scores_as_of date not null
);
alter table hopper.benchmark_scores enable row level security;

-- Every tag change made in the app, kept as the signal for tuning the tagger.
create table hopper.corrections (
  id bigint generated always as identity primary key,
  note_id uuid references hopper.notes(id) on delete set null,
  facet text not null,
  action text not null,
  old_value text,
  new_value text,
  at timestamp with time zone not null default now()
);

-- Navigation taps in the app (open, pill, sheet, sheet_pick, topic), counted silently.
create table hopper.ui_events (
  id bigint generated always as identity primary key,
  event text not null check (event in ('open', 'pill', 'sheet', 'sheet_pick', 'topic')),
  project_id uuid references hopper.projects(id) on delete set null,
  topic text,
  device text check (device in ('phone', 'desktop')),
  at timestamp with time zone not null default now()
);
create index ui_events_at_idx on hopper.ui_events (at);
alter table hopper.ui_events enable row level security;

create table hopper.batches (
  id text not null primary key,
  model text not null,
  prompt_version integer,
  note_count integer,
  note_ids uuid[] not null default '{}'::uuid[],
  status text,
  counts jsonb,
  submitted_at timestamp with time zone not null default now()
);

-- Key/value settings: owner_email, invoke_token_sha256, embed_* job state.
create table hopper.settings (
  key text not null primary key,
  value text not null
);

-- Indexes
create index attachments_note_idx on hopper.attachments (note_id);
create index attachments_role_idx on hopper.attachments (note_id, image_role);
create index attachments_moves_idx on hopper.attachments using gin (moves);
create index benchmark_scores_visual_idx on hopper.benchmark_scores (visual_quality desc nulls last);
create index benchmark_scores_presentation_idx on hopper.benchmark_scores (presentation desc nulls last);
create index note_links_note_idx on hopper.note_links (note_id);
create index note_people_person_idx on hopper.note_people (person_id);
create index note_projects_project_idx on hopper.note_projects (project_id);
create index note_topics_topic_idx on hopper.note_topics (topic_id);
create index note_works_work_idx on hopper.note_works (work_id);
create index notes_aesthetics_idx on hopper.notes using gin (aesthetics);
create index notes_created_idx on hopper.notes (created_at desc);
create index notes_format_idx on hopper.notes (format);
create index notes_locked_idx on hopper.notes (is_locked);
create index works_person_idx on hopper.works (person_id);

-- Views
create or replace view hopper.note_cards as
 select id, title, format, created_at, is_locked, archived,
   case
     when format in ('bookmark','reference','component','image') or coalesce(trim(body), '') = ''
       then coalesce(nullif(summary, ''), left(body, 220))
     else left(body, 220)
   end as excerpt,
   (select a.storage_path from hopper.attachments a where a.note_id = n.id limit 1) as image_path,
   (select l.thumbnail_url from hopper.note_links l where l.note_id = n.id and l.thumbnail_url is not null limit 1) as link_thumb,
   (select l.url from hopper.note_links l where l.note_id = n.id limit 1) as link_url,
   (select array_agg(p.name) from hopper.note_projects np join hopper.projects p on p.id = np.project_id where np.note_id = n.id) as projects,
   pinned, keep_color, lock_source
 from hopper.notes n;
-- New columns can only be appended at the end of this view.

-- The only door to note content for AI work: locked notes never pass through it.
create or replace view hopper.notes_for_ai as
 select id, source, title, body, list_items, created_at, edited_at, archived, pinned,
   keep_labels, format, period, summary, confidence, cull_candidate, tagged_at, reviewed,
   aesthetics, why_saved, anti_reference
 from hopper.notes
 where is_locked = false;

-- Functions

-- Calls a hopper-* edge function from the database via pg_net, using the Vault secret.
create or replace function hopper.call_fn(p_slug text, p_body jsonb, p_timeout_ms integer default 150000)
 returns bigint language plpgsql security definer set search_path to ''
as $function$
declare tok text; rid bigint;
begin
  if p_slug not like 'hopper-%' then raise exception 'only hopper functions'; end if;
  select decrypted_secret into tok from vault.decrypted_secrets where name = 'hopper_invoke_token';
  select net.http_post(
    url := 'https://hhfjfbuiuhhdhwhfwlpv.supabase.co/functions/v1/' || p_slug,
    body := p_body,
    headers := jsonb_build_object('content-type', 'application/json', 'x-hopper-token', tok),
    timeout_milliseconds := p_timeout_ms) into rid;
  return rid;
end $function$;

-- One tick of the embedding job (pg_cron 'hopper-embed', every 20 seconds).
-- Unschedules itself when nothing is left or after embed_stop_after.
create or replace function hopper.embed_tick()
 returns void language plpgsql security definer set search_path to ''
as $function$
declare last_rid bigint; last_at timestamptz; stop_after timestamptz; remaining int; rid bigint;
begin
  select value::timestamptz into stop_after from hopper.settings where key = 'embed_stop_after';
  select count(*) into remaining from hopper.notes n
   where not n.is_locked and n.tagged_at is not null
     and not exists (select 1 from hopper.note_embeddings e where e.note_id = n.id);
  if remaining = 0 or (stop_after is not null and now() > stop_after) then
    perform cron.unschedule('hopper-embed');
    return;
  end if;
  select value::bigint into last_rid from hopper.settings where key = 'embed_last_rid';
  select value::timestamptz into last_at from hopper.settings where key = 'embed_last_at';
  if last_rid is not null
     and not exists (select 1 from net._http_response where id = last_rid)
     and last_at > now() - interval '3 minutes' then
    return;
  end if;
  rid := hopper.call_fn('hopper-embed', '{"limit":4}'::jsonb, 140000);
  insert into hopper.settings (key, value) values ('embed_last_rid', rid::text), ('embed_last_at', now()::text)
  on conflict (key) do update set value = excluded.value;
end $function$;

-- Safety check run on every insert: locks notes that look like secrets or ID numbers.
create or replace function hopper.pattern_check(p_title text, p_body text, p_list jsonb)
 returns text language plpgsql immutable set search_path to ''
as $function$
declare
  t text := coalesce(p_title,'') || E'\n' || coalesce(p_body,'') || E'\n' || coalesce(p_list::text,'');
  b text := btrim(coalesce(p_body,''));
begin
  if t ~ '(github_pat_|ghp_[A-Za-z0-9]{20,}|sk-ant-|\msk-[A-Za-z0-9]{32,}|xox[bp]-[A-Za-z0-9-]{10,})' then return 'access token or API key'; end if;
  if t ~* '(authorization\s*:|bearer\s+[A-Za-z0-9._-]{20,}|apikey\s*[:=])' then return 'request with credentials'; end if;
  if t ~* '\m(pass(word|code|phrase)?|pwd|pw|username|user name|login)\M\s*[:=-]' then return 'password or login'; end if;
  if t ~* '(recovery|backup) (code|key|phrase)|seed phrase' then return 'recovery code'; end if;
  if t ~ '(^|[^0-9])([0-9][ -]?){15,16}([^0-9]|$)' then return 'card-length number'; end if;
  if t ~* '(sort code|\miban\M|account (no|number))' or t ~ '\m[0-9]{2}-[0-9]{2}-[0-9]{2}\M' then return 'bank details'; end if;
  if t ~ '\m([A-Z0-9]{5}-){4}[A-Z0-9]{5}\M' then return 'licence key'; end if;
  if t ~* '(passport (no|number)|national insurance|\mni number|nhs number|driving licen[cs]e (no|number))'
     or t ~ '\m[A-CEGHJ-PR-TW-Z]{2} ?[0-9]{2} ?[0-9]{2} ?[0-9]{2} ?[A-D]\M' then return 'identity number'; end if;
  if t ~* '\m(pin|cvv|cvc|security code|door code|alarm code)\M\s*[:=-]?\s*[0-9]{3,}' then return 'PIN or security code'; end if;
  if b ~ '^[0-9]{4,6}$' then return 'bare short number'; end if;
  if b ~ '^[0-9 ]{9,16}$' then return 'bare long number'; end if;
  if length(b) between 6 and 60 and b !~* 'https?://' and array_length(regexp_split_to_array(b, '\s+'), 1) <= 4
     and b ~ '(^|\s)(?=\S*[A-Za-z])(?=\S*[0-9])\S*([!@#$%^&*]|[A-Za-z]{4,}[0-9]{2,})\S*(\s|$)' then return 'looks like a password'; end if;
  return null;
end $function$;

create or replace function hopper.pattern_lock()
 returns trigger language plpgsql set search_path to ''
as $function$
declare reason text;
begin
  if new.is_locked then return new; end if;
  reason := hopper.pattern_check(new.title, new.body, new.list_items);
  if reason is not null then
    new.is_locked := true; new.lock_source := 'pattern'; new.lock_reason := reason;
  end if;
  return new;
end $function$;

create trigger notes_pattern_lock before insert on hopper.notes
  for each row execute function hopper.pattern_lock();
