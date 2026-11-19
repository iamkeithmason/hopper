-- Navigation taps in the app, counted silently like hopper.corrections.
-- First use (19 Nov 2026): a week's baseline of project switching on the current top pills,
-- to decide whether the phone gets a bottom dock (backlog: "Bottom dock for search and project pills").
-- event: open (app opened or brought back), pill (project pill), sheet (All projects sheet opened),
--        sheet_pick (project chosen in the sheet), topic (topic/section pill).
-- device: phone or desktop, from the viewport width when the tap happened.
create table hopper.ui_events (
  id bigint generated always as identity primary key,
  event text not null check (event in ('open', 'pill', 'sheet', 'sheet_pick', 'topic')),
  project_id uuid references hopper.projects(id) on delete set null,
  topic text,
  device text check (device in ('phone', 'desktop')),
  at timestamp with time zone not null default now()
);

create index ui_events_at_idx on hopper.ui_events (at);
