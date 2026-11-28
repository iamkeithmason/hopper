-- Backfill medium on notes saved before 20261128150000_hopper_medium_borrow, by the same rules as its triggers, marked
-- inferred. Keith approved 28 Nov 2026. Only notes with no medium are touched; borrow is left empty.

-- Notes with a link: a video site is a video, a Pinterest pin an image, anything else a web page (one link per note decides).
update hopper.notes n set medium = x.m, medium_inferred = true
from (
  select distinct on (l.note_id) l.note_id,
    case
      when l.kind = 'video' or l.url ~* '^https?://([a-z]+\.)?(youtube\.com/(watch|shorts|live)|youtu\.be/|vimeo\.com/\d)' then 'video'
      when l.url ~* '^https?://([a-z]+\.)?pinterest\.[a-z.]+/pin/|^https?://pin\.it/' then 'image'
      else 'web-page' end as m
  from hopper.note_links l
  order by l.note_id, l.id
) x
where n.id = x.note_id and n.medium is null;

-- Notes with a picture of their own and no link are images.
update hopper.notes n set medium = 'image', medium_inferred = true
where n.medium is null
  and exists (select 1 from hopper.attachments a where a.note_id = n.id and a.image_role is null)
  and not exists (select 1 from hopper.note_links l where l.note_id = n.id);
