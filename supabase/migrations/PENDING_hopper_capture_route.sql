-- HOP-43: record how and on what each note was captured.
-- capture_route: share (share sheet into the app), new (the app's + button), extension (browser extension),
--   mcp (Claude through hopper-mcp), app (saved in the app before routes were recorded),
--   keep-import, blog-import, notion-clip (imports and clips, from notes.source).
-- capture_device: a coarse device name from the browser's user agent (iPhone, iPad, Android phone, Mac, Windows...),
--   set by hopper-api; null where it isn't known (imports, Claude, and everything saved before this).

alter table hopper.notes add column if not exists capture_route text, add column if not exists capture_device text;

create or replace function hopper.route_for_source(p_source text) returns text
  language sql immutable set search_path to ''
as $$
  select case p_source
    when 'blog' then 'blog-import'
    when 'assistant' then 'mcp'
    else p_source end
$$;

-- Imports and anything else that doesn't say its route get one from their source.
create or replace function hopper.default_capture_route() returns trigger
  language plpgsql set search_path to ''
as $$
begin
  new.capture_route := coalesce(new.capture_route, hopper.route_for_source(new.source));
  return new;
end
$$;

drop trigger if exists notes_capture_route on hopper.notes;
create trigger notes_capture_route before insert on hopper.notes
  for each row execute function hopper.default_capture_route();

-- Backfill (approved by Keith, 25 Nov 2026). Touches only capture_route, so no update triggers fire.
update hopper.notes set capture_route = hopper.route_for_source(source) where capture_route is null;

-- Captures a week by route and device (binned notes included: they were still captured).
create or replace view hopper.capture_counts_weekly as
  select date_trunc('week', created_at)::date as week, capture_route as route,
         coalesce(capture_device, 'unknown') as device, count(*)::int as notes
  from hopper.notes
  group by 1, 2, 3;

revoke all on hopper.capture_counts_weekly from public, anon, authenticated;
