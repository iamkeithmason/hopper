-- HOP-50: a link Hopper's plain fetch was refused but the screenshot browser read gets fetch_status 'browser'.
-- HOP-55, 56, 57: measurements taken in the capture browser for each captured page, stored on its link.
--   motion: what moves and how (duration, easing, delay, travel, stagger, trigger, reduced-motion behaviour, library),
--           measured from navigation so entrance motion is caught.
--   type_scale: the page's distinct text treatments (family, size, weight, line height, tracking) with the roles
--           and counts of where each is used, and its icon sizes with their boxes, at 1440 and 390 wide.
-- Measurements only: no page text beyond short role labels, and nothing here is sent to a model.

alter table hopper.note_links drop constraint if exists note_links_fetch_status_check;
alter table hopper.note_links add constraint note_links_fetch_status_check
  check (fetch_status in ('ok','browser','dead','blocked','private','timeout','error','skipped'));

alter table hopper.note_links
  add column if not exists motion jsonb,
  add column if not exists type_scale jsonb;
