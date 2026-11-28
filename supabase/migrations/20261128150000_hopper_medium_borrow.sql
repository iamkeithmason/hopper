-- Reference model, step one (stress test of 28 Nov 2026): every note can say what it is (medium) apart from what Keith
-- wants to learn from it (borrow). Medium decides how much capture work a save deserves; borrow records the intent.
-- Values Hopper guesses carry an inferred flag, so a later review can tell Keith's intent (or Claude's, from the
-- conversation) from Hopper's guess.

alter table hopper.notes
  add column if not exists medium text,
  add column if not exists medium_inferred boolean not null default false,
  add column if not exists borrow text[] not null default '{}'::text[],
  add column if not exists borrow_inferred boolean not null default false;

alter table hopper.notes drop constraint if exists notes_medium_check;
alter table hopper.notes add constraint notes_medium_check
  check (medium in ('web-page', 'app-screen', 'print-page', 'image', 'video'));
alter table hopper.notes drop constraint if exists notes_borrow_check;
alter table hopper.notes add constraint notes_borrow_check
  check (borrow <@ array['layout', 'type', 'palette', 'component', 'voice', 'motion', 'illustration', 'identity',
                         'documentation', 'mockup']::text[]);

create index if not exists notes_medium_idx on hopper.notes (medium);
create index if not exists notes_borrow_idx on hopper.notes using gin (borrow);

-- notes_for_ai carries the four columns (appended at the end, so the view keeps its columns in order).
create or replace view hopper.notes_for_ai as
 select id, source, title, body, list_items, created_at, edited_at, archived, pinned,
   keep_labels, format, period, summary, confidence, cull_candidate, tagged_at, reviewed,
   aesthetics, why_saved, anti_reference, set_read, medium, borrow, medium_inferred, borrow_inferred
 from hopper.notes
 where is_locked = false and deleted_at is null;

-- Medium from what arrived, for every capture route (share, app, extension, MCP, import), marked inferred.
-- A link makes the note a web page, or a video for video sites, or an image for a Pinterest pin. A picture of the
-- note's own (no page role: not a screenshot or a page figure) on a note with no link makes it an image.
-- A stated medium is never overwritten; a link replaces an inferred image (an image saved before its page).
create or replace function hopper.medium_from_link() returns trigger
  language plpgsql set search_path to ''
as $$
declare m text;
begin
  m := case
    when new.kind = 'video' or new.url ~* '^https?://([a-z]+\.)?(youtube\.com/(watch|shorts|live)|youtu\.be/|vimeo\.com/\d)' then 'video'
    when new.url ~* '^https?://([a-z]+\.)?pinterest\.[a-z.]+/pin/|^https?://pin\.it/' then 'image'
    else 'web-page' end;
  update hopper.notes set medium = m, medium_inferred = true
   where id = new.note_id and (medium is null or (medium_inferred and medium = 'image' and m <> 'image'));
  return new;
end
$$;
drop trigger if exists note_links_infer_medium on hopper.note_links;
create trigger note_links_infer_medium after insert on hopper.note_links
  for each row execute function hopper.medium_from_link();

create or replace function hopper.medium_from_image() returns trigger
  language plpgsql set search_path to ''
as $$
begin
  if new.image_role is null then
    update hopper.notes n set medium = 'image', medium_inferred = true
     where n.id = new.note_id and n.medium is null
       and not exists (select 1 from hopper.note_links l where l.note_id = n.id);
  end if;
  return new;
end
$$;
drop trigger if exists attachments_infer_medium on hopper.attachments;
create trigger attachments_infer_medium after insert on hopper.attachments
  for each row execute function hopper.medium_from_image();
