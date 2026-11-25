-- HOP-31: set reads. One design read of all of a note's own images together (kinds of page in the set, what stays
-- constant, what varies, order, how to borrow), written by hopper-design to notes.set_read. Keith approved 25 Nov 2026.

alter table hopper.notes add column if not exists set_read jsonb;

-- notes_for_ai carries the set read (appended at the end, so the view keeps its columns in order).
create or replace view hopper.notes_for_ai as
 select id, source, title, body, list_items, created_at, edited_at, archived, pinned,
   keep_labels, format, period, summary, confidence, cull_candidate, tagged_at, reviewed,
   aesthetics, why_saved, anti_reference, set_read
 from hopper.notes
 where is_locked = false and deleted_at is null;

-- Locking a note drops its set read (before the update, so the row is written once).
create or replace function hopper.clear_set_read_on_lock() returns trigger
  language plpgsql set search_path to ''
as $$
begin
  if new.is_locked and not old.is_locked then new.set_read := null; end if;
  return new;
end
$$;
drop trigger if exists notes_clear_set_read_on_lock on hopper.notes;
create trigger notes_clear_set_read_on_lock before update of is_locked on hopper.notes
  for each row execute function hopper.clear_set_read_on_lock();

-- Notes waiting for a set read: unlocked, cleared by the tagger, two or more of their own images (or page figures),
-- every one already read on its own, and no set read yet or one made from a different number of images.
create or replace function hopper.sets_waiting() returns setof uuid
  language sql stable set search_path to ''
as $$
  select n.id from hopper.notes_for_ai n
  join hopper.attachments a on a.note_id = n.id and a.storage_path is not null and (a.image_role is null or a.image_role = 'figure')
  where n.tagged_at is not null
  group by n.id, n.set_read
  having count(*) >= 2 and bool_and(a.design_read is not null)
     and (n.set_read is null or coalesce((n.set_read->>'n')::int, 0) <> least(count(*), 8))
$$;

-- The design sweep also runs when a set read is waiting (hopper-design reads one set a run once no single image
-- or page is waiting).
create or replace function hopper.design_sweep() returns bigint
  language plpgsql security definer set search_path to ''
as $function$
begin
  if coalesce((select value from hopper.settings where key = 'auto_design'), 'off') <> 'on' then return null; end if;
  if not exists (select 1 from hopper.attachments a join hopper.notes_for_ai n on n.id = a.note_id
                 where a.storage_path is not null and n.tagged_at is not null and a.design_read is null
                   and (a.image_role is null or a.image_role = 'figure'))
     and not exists (select 1 from hopper.note_links l join hopper.notes_for_ai n on n.id = l.note_id
                     where n.tagged_at is not null
                       and exists (select 1 from hopper.attachments a where a.note_id = l.note_id and a.source_page_url = l.url
                                   and a.storage_path is not null and a.image_role in ('first-screen-1440', 'first-screen-390', 'full-page'))
                       and (l.layout_read is null or coalesce((l.layout_read->>'v')::int, 0) < 1
                            or exists (select 1 from hopper.attachments a where a.note_id = l.note_id and a.source_page_url = l.url
                                       and a.image_role in ('first-screen-1440', 'first-screen-390', 'full-page')
                                       and a.captured_on > (l.layout_read->>'read_at')::timestamptz::date)))
     and not exists (select 1 from hopper.sets_waiting()) then
    return null;
  end if;
  return hopper.call_fn('hopper-design', jsonb_build_object('next', 2, 'write', true), 150000);
end $function$;
