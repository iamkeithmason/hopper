-- HOP-21: notes imported from Keith's Notion Articles database (web clips) get their own source.
alter table hopper.notes drop constraint notes_source_check;
alter table hopper.notes add constraint notes_source_check
  check (source = any (array['keep-import', 'app', 'assistant', 'blog', 'notion-clip']));
