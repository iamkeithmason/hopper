-- HOP-60: projects Claude sets through the MCP (save_to_hopper's projects, set_note_projects) are recorded as
-- added_by 'assistant', confirmed, so the tagger keeps them and the app can tell them from Keith's own.
alter table hopper.note_projects drop constraint note_projects_added_by_check;
alter table hopper.note_projects add constraint note_projects_added_by_check
  check (added_by = any (array['ai', 'keith', 'rule', 'import', 'assistant']));
