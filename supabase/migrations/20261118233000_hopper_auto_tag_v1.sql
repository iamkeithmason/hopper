-- HOP-5: tag new captures automatically (Haiku), behind a switch that starts off.
-- Also closes a gap: the pattern check now runs when a note's title or body is edited, not only on insert.

insert into hopper.settings (key, value) values ('auto_tag', 'off')
  on conflict (key) do nothing;

-- Tag one note straight after capture. Does nothing while the switch is off or the note is locked.
create or replace function hopper.tag_new(p_id uuid)
returns bigint
language plpgsql
security definer
set search_path to ''
as $$
begin
  if coalesce((select value from hopper.settings where key = 'auto_tag'), 'off') <> 'on' then return null; end if;
  if not exists (select 1 from hopper.notes_for_ai where id = p_id) then return null; end if;
  return hopper.call_fn('hopper-tag', jsonb_build_object('ids', jsonb_build_array(p_id), 'model', 'claude-haiku-5-5', 'write', true), 120000);
end $$;

-- Sweep: anything untagged and unlocked (missed captures, notes edited since tagging), 15 at a time.
-- Waits two minutes after the last edit so a note being typed is tagged once, not on every save.
create or replace function hopper.tag_sweep()
returns bigint
language plpgsql
security definer
set search_path to ''
as $$
begin
  if coalesce((select value from hopper.settings where key = 'auto_tag'), 'off') <> 'on' then return null; end if;
  if not exists (select 1 from hopper.notes_for_ai
                 where tagged_at is null and coalesce(edited_at, created_at) < now() - interval '2 minutes') then return null; end if;
  return hopper.call_fn('hopper-tag', jsonb_build_object('next', 15, 'model', 'claude-haiku-5-5', 'write', true), 150000);
end $$;

revoke all on function hopper.tag_new(uuid) from public, anon, authenticated;
revoke all on function hopper.tag_sweep() from public, anon, authenticated;

-- Pattern check on edits as well as inserts. A note Keith has unlocked himself is not locked again.
create or replace function hopper.pattern_lock_edit()
returns trigger
language plpgsql
set search_path to ''
as $$
begin
  if new.is_locked then return new; end if;
  if exists (select 1 from hopper.corrections c where c.note_id = new.id and c.facet = 'lock' and c.action = 'unlock') then return new; end if;
  return hopper.pattern_lock_row(new);
end $$;

-- The insert trigger's logic, callable from the edit trigger.
create or replace function hopper.pattern_lock_row(r hopper.notes)
returns hopper.notes
language plpgsql
set search_path to ''
as $$
declare reason text;
begin
  reason := hopper.pattern_check(r.title, r.body, r.list_items);
  if reason is not null then
    r.is_locked := true; r.lock_source := 'pattern'; r.lock_reason := reason;
  end if;
  return r;
end $$;

drop trigger if exists notes_pattern_lock_update on hopper.notes;
create trigger notes_pattern_lock_update before update of title, body, list_items on hopper.notes
  for each row execute function hopper.pattern_lock_edit();

-- A note that becomes locked loses its embedding, whoever locked it.
create or replace function hopper.drop_locked_embedding()
returns trigger
language plpgsql
set search_path to ''
as $$
begin
  delete from hopper.note_embeddings where note_id = new.id;
  return null;
end $$;

drop trigger if exists notes_locked_embedding on hopper.notes;
create trigger notes_locked_embedding after update of is_locked on hopper.notes
  for each row when (new.is_locked and not old.is_locked) execute function hopper.drop_locked_embedding();

select cron.schedule('hopper-tag-sweep', '*/20 * * * *', 'select hopper.tag_sweep()');
