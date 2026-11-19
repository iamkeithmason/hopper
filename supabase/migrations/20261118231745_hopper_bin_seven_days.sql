-- Recovered on 19 Nov from supabase_migrations.schema_migrations: this migration was applied to the live
-- database on 18 Nov (with hopper-api v10) but never committed. The SQL below is as applied.

-- Bin: Delete now sets deleted_at; the note is erased 7 days later by the nightly hopper-bin job.
alter table hopper.notes add column if not exists deleted_at timestamptz;
create index if not exists notes_deleted_at_idx on hopper.notes (deleted_at) where deleted_at is not null;

-- The AI never sees binned notes (MCP server, tag sweep, tag_new all read this view).
create or replace view hopper.notes_for_ai as
 SELECT id, source, title, body, list_items, created_at, edited_at, archived, pinned, keep_labels, format, period,
        summary, confidence, cull_candidate, tagged_at, reviewed, aesthetics, why_saved, anti_reference
   FROM hopper.notes
  WHERE is_locked = false and deleted_at is null;

-- Cards carry deleted_at so the API can list the Bin and hide binned notes elsewhere.
create or replace view hopper.note_cards as
 SELECT id, title, format, created_at, is_locked, archived,
        CASE
            WHEN format = ANY (ARRAY['bookmark','reference','component','image']) OR COALESCE(TRIM(BOTH FROM body), '') = ''
              THEN COALESCE(NULLIF(summary, ''), "left"(body, 220))
            ELSE "left"(body, 220)
        END AS excerpt,
        (SELECT a.storage_path FROM hopper.attachments a WHERE a.note_id = n.id LIMIT 1) AS image_path,
        (SELECT l.thumbnail_url FROM hopper.note_links l WHERE l.note_id = n.id AND l.thumbnail_url IS NOT NULL LIMIT 1) AS link_thumb,
        (SELECT l.url FROM hopper.note_links l WHERE l.note_id = n.id LIMIT 1) AS link_url,
        (SELECT array_agg(p.name) FROM hopper.note_projects np JOIN hopper.projects p ON p.id = np.project_id WHERE np.note_id = n.id) AS projects,
        pinned, keep_color, lock_source, deleted_at
   FROM hopper.notes n;

-- Binned notes can't be filed into projects.
create or replace function hopper.file_note(p_note uuid)
 returns table(project text, band text)
 language plpgsql security definer
 set search_path to 'extensions', 'pg_catalog'
as $function$
declare r record; n_in int := 0;
begin
  if not exists (select 1 from hopper.notes where id = p_note and not is_locked and deleted_at is null) then return; end if;
  for r in
    select s.* from hopper.project_scores(p_note) s
     where s.band = 'In'
       and not exists (select 1 from hopper.note_projects np where np.note_id = p_note and np.project_id = s.project_id)
       and not exists (select 1 from hopper.tag_rejections tr where tr.note_id = p_note and tr.project_id = s.project_id)
  loop
    insert into hopper.note_projects (note_id, project_id, confidence, confirmed, added_by, reason_note_id)
    values (p_note, r.project_id, 'high', false, 'rule', r.nearest_note);
    n_in := n_in + 1; project := r.project; band := 'In'; return next;
  end loop;
  if n_in = 0 and not exists (select 1 from hopper.note_projects np where np.note_id = p_note) then
    select s.* into r from hopper.project_scores(p_note) s
     where s.band = 'Nearby'
       and not exists (select 1 from hopper.tag_rejections tr where tr.note_id = p_note and tr.project_id = s.project_id)
     limit 1;
    if found then
      insert into hopper.note_projects (note_id, project_id, confidence, confirmed, added_by, reason_note_id)
      values (p_note, r.project_id, 'low', false, 'rule', r.nearest_note);
      project := r.project; band := 'Nearby'; return next;
    end if;
  end if;
end $function$;

-- Nightly: if anything has sat in the Bin for 7 days, ask hopper-api to erase it (the API also removes image files).
create or replace function hopper.bin_tick()
 returns bigint
 language plpgsql security definer
 set search_path to ''
as $function$
begin
  if not exists (select 1 from hopper.notes where deleted_at < now() - interval '7 days') then return null; end if;
  return hopper.call_fn('hopper-api', '{"action":"empty_bin"}'::jsonb, 120000);
end $function$;
revoke all on function hopper.bin_tick() from public, anon, authenticated;

select cron.schedule('hopper-bin', '41 4 * * *', 'select hopper.bin_tick()');
