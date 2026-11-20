-- Portfolio benchmarks, part 1: page context on images and pages, and benchmark scores.
--
-- Images (attachments) say what part of a page they are and where they sat on it, so visual craft can be judged
-- at the scale it was shown: role, the page they came from, the caption beside them on the page, their rendered
-- size and their distance from the top of the page, all at a 1440 px wide window.
-- Pages (note_links) carry the page's height, how many videos it holds, when it was captured and a layout read
-- (how much of the first screen is real product UI, the widest figure, whether one image treatment holds, motion).
-- Benchmark scores live in hopper.benchmark_scores, one row per benchmark note. Notion's "Portfolio Benchmarks"
-- database is the source of truth: these are copies with scores_as_of and a link back to the Notion row, and the
-- formulas stay in Notion.

alter table hopper.attachments
  add column image_role text,
  add column source_page_url text,
  add column caption_on_page text,
  add column rendered_width_at_1440 integer,
  add column rendered_height_at_1440 integer,
  add column position_from_top_px_at_1440 integer,
  add column captured_on date,
  add constraint attachments_image_role_check
    check (image_role in ('first-screen-1440', 'first-screen-390', 'full-page', 'figure'));

-- Page screenshots taken by hopper-shot already have a role.
update hopper.attachments set image_role = 'first-screen-1440' where original_file = 'screenshot:first' and image_role is null;
update hopper.attachments set image_role = 'full-page' where original_file = 'screenshot:full' and image_role is null;

create index attachments_role_idx on hopper.attachments (note_id, image_role);

alter table hopper.note_links
  add column page_height_px_at_1440 integer,
  add column videos_on_page integer,
  add column captured_on date,
  add column layout_read jsonb;

create table hopper.benchmark_scores (
  note_id uuid primary key references hopper.notes(id) on delete cascade,
  name text not null,
  site_url text not null,
  scores_source text not null,           -- the Notion row
  status text not null check (status in ('Reviewed', 'To review')),
  rank_overall integer,                   -- among scored benchmarks, Keith's own row excluded; ties share a rank
  overall numeric(3,2),
  substance numeric(3,2),
  presentation numeric(3,2),
  visual_quality smallint check (visual_quality between 1 and 5),
  shell_craft smallint check (shell_craft between 1 and 5),
  work_legibility smallint check (work_legibility between 1 and 5),
  contribution_clarity smallint check (contribution_clarity between 1 and 5),
  leadership_evidence smallint check (leadership_evidence between 1 and 5),
  outcome_evidence smallint check (outcome_evidence between 1 and 5),
  scores_as_of date not null
);
create index benchmark_scores_visual_idx on hopper.benchmark_scores (visual_quality desc nulls last);
create index benchmark_scores_presentation_idx on hopper.benchmark_scores (presentation desc nulls last);
alter table hopper.benchmark_scores enable row level security;
revoke all on hopper.benchmark_scores from public, anon, authenticated;
