-- #79: a tall page kept as tiles at native width, one per section (image_role 'page-tile'), beside the scaled
-- whole-page shot. Tiles are for reading the page closely (get_reference, the note view); the page read keeps using the
-- scaled whole page, so tiles never trigger a new read.
alter table hopper.attachments drop constraint attachments_image_role_check;
alter table hopper.attachments add constraint attachments_image_role_check
  check (image_role in ('first-screen-1440', 'first-screen-390', 'full-page', 'figure', 'motion-strip', 'page-tile'));
comment on column hopper.attachments.image_role is
  'first-screen-1440, first-screen-390, full-page, figure, motion-strip or page-tile (a section of the page at 1440, top at position_from_top_px_at_1440)';
