-- Visual moves: what an image does as design, from a controlled list, so references can be found by move
-- ("every annotated screen across my benchmarks"). Several moves per image. Add a term only once a new move
-- has turned up twice.

create table hopper.moves (
  name text primary key,
  description text not null,
  added_on date not null default current_date
);
alter table hopper.moves enable row level security;
revoke all on hopper.moves from public, anon, authenticated;

insert into hopper.moves (name, description) values
  ('annotated-screen', 'Labels or callouts pinned to a real screen. Say whether they name tokens or styles, or state decisions.'),
  ('component-collage', 'Real components at native size, arranged as one image.'),
  ('token-diagram', 'How design tokens are named or layered.'),
  ('before-after', 'The same screen or artefact in two states, side by side.'),
  ('state-change', 'One screen moving between stages, as frames or motion.'),
  ('device-mockup', 'Work shown inside a device or a physical setting.'),
  ('full-bleed-lead', 'A lead screen breaking out of the text column near full width.'),
  ('process-artefact', 'Boards, maps, workshops, sketches.'),
  ('brand-system-spread', 'The same identity across several touchpoints.'),
  ('credit-line', 'A figure credited to the person who made it.');

alter table hopper.attachments add column moves text[] not null default '{}';
create index attachments_moves_idx on hopper.attachments using gin (moves);
