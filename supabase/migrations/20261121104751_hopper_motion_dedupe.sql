-- Motion strips and byte dedupe.
-- A captured page can now hold a motion strip (image_role 'motion-strip'): three frames of its first screen, or of its
-- first video, taken a second apart, kept only when the frames differ. Strips feed the page read like the other
-- screenshots and get no read of their own.
-- content_sha256 is the sha256 of an image's stored bytes, so the same picture arriving under a second address is
-- not stored twice on one note.

alter table hopper.attachments drop constraint attachments_image_role_check;
alter table hopper.attachments add constraint attachments_image_role_check
  check (image_role in ('first-screen-1440', 'first-screen-390', 'full-page', 'figure', 'motion-strip'));

alter table hopper.attachments add column content_sha256 text;
create index attachments_content_sha256_idx on hopper.attachments (note_id, content_sha256) where content_sha256 is not null;
