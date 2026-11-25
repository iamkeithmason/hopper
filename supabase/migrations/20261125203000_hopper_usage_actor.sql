-- HOP-63: record which notes get opened and what gets searched, and who did it:
-- Keith in the app, or Claude through the MCP. Searches keep only their length, never their words.

alter table hopper.ui_events
  add column if not exists actor text not null default 'keith',
  add column if not exists note_id uuid references hopper.notes(id) on delete set null,
  add column if not exists tool text,
  add column if not exists query_len integer,
  add column if not exists result_ids uuid[];

alter table hopper.ui_events drop constraint if exists ui_events_actor_check;
alter table hopper.ui_events add constraint ui_events_actor_check check (actor in ('keith', 'claude'));

alter table hopper.ui_events drop constraint if exists ui_events_event_check;
alter table hopper.ui_events add constraint ui_events_event_check
  check (event in ('open', 'pill', 'sheet', 'sheet_pick', 'topic', 'note_open', 'search', 'mcp_call'));

create index if not exists ui_events_note_idx on hopper.ui_events (note_id) where note_id is not null;

-- Opens, searches and other MCP calls a week, by who did them. Age is how old the note was when it was opened
-- or pulled up by a search, so "older than 90 days" shows whether old saves come back.
create or replace view hopper.revisits_weekly as
  with ev as (
    select date_trunc('week', at)::date as week, actor, event, count(*)::int as events
    from hopper.ui_events where event in ('note_open', 'search', 'mcp_call')
    group by 1, 2, 3
  ),
  touched as (
    select e.at, e.actor, e.event, e.note_id from hopper.ui_events e where e.note_id is not null
    union all
    select e.at, e.actor, e.event, r.note_id from hopper.ui_events e, unnest(e.result_ids) as r(note_id)
  ),
  ages as (
    select date_trunc('week', t.at)::date as week, t.actor, t.event, t.note_id,
           extract(epoch from t.at - n.created_at) / 86400 as age_days
    from touched t join hopper.notes n on n.id = t.note_id
  ),
  ag as (
    select week, actor, event, count(distinct note_id)::int as notes,
           round(percentile_cont(0.5) within group (order by age_days))::int as median_age_days,
           count(distinct note_id) filter (where age_days > 90)::int as notes_older_than_90_days
    from ages group by 1, 2, 3
  )
  select ev.week, ev.actor, ev.event, ev.events, coalesce(ag.notes, 0) as notes, ag.median_age_days,
         coalesce(ag.notes_older_than_90_days, 0) as notes_older_than_90_days
  from ev left join ag using (week, actor, event);

revoke all on hopper.revisits_weekly from public, anon, authenticated;
