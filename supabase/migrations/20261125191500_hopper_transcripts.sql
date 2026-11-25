-- HOP-61: transcripts and short summaries for saved videos.
-- Transcripts come from a browser (the extension on a YouTube page, or Claude through hopper-mcp's add_transcript)
-- into the existing note_links.transcript column; hopper-transcript writes transcript_summary with Claude Haiku,
-- reading through hopper.notes_for_ai so locked notes are never sent.

alter table hopper.note_links
  add column if not exists transcript_summary text,
  add column if not exists transcript_language text,
  add column if not exists transcript_source text,
  add column if not exists transcript_at timestamp with time zone,
  add column if not exists transcript_model text;

alter table hopper.note_links drop constraint if exists note_links_transcript_source_check;
alter table hopper.note_links add constraint note_links_transcript_source_check
  check (transcript_source in ('extension', 'assistant'));

-- Locking a note drops its video summaries, as it drops the note's own summary and embedding.
create or replace function hopper.clear_ai_on_lock() returns trigger
  language plpgsql set search_path to ''
as $$
begin
  if new.is_locked and not old.is_locked then
    update hopper.note_links set transcript_summary = null, transcript_model = null where note_id = new.id;
  end if;
  return new;
end
$$;

drop trigger if exists notes_clear_ai_on_lock on hopper.notes;
create trigger notes_clear_ai_on_lock after update of is_locked on hopper.notes
  for each row execute function hopper.clear_ai_on_lock();
