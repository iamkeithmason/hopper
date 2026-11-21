-- Pages are read as pages (hopper-design version 4). A captured page's screenshots (first screens at 1440 and 390,
-- the whole page) feed one page read on its link (note_links.layout_read); they no longer get reads of their own.
-- The design sweep now runs when either a page or a single image (no role, or a figure) is waiting.

create or replace function hopper.design_sweep()
 returns bigint
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  if coalesce((select value from hopper.settings where key = 'auto_design'), 'off') <> 'on' then return null; end if;
  if not exists (select 1 from hopper.attachments a join hopper.notes_for_ai n on n.id = a.note_id
                 where a.storage_path is not null and n.tagged_at is not null and a.design_read is null
                   and (a.image_role is null or a.image_role = 'figure'))
     and not exists (select 1 from hopper.note_links l join hopper.notes_for_ai n on n.id = l.note_id
                     where n.tagged_at is not null
                       and exists (select 1 from hopper.attachments a where a.note_id = l.note_id and a.source_page_url = l.url
                                   and a.storage_path is not null and a.image_role in ('first-screen-1440', 'first-screen-390', 'full-page'))
                       and (l.layout_read is null or coalesce((l.layout_read->>'v')::int, 0) < 1
                            or exists (select 1 from hopper.attachments a where a.note_id = l.note_id and a.source_page_url = l.url
                                       and a.image_role in ('first-screen-1440', 'first-screen-390', 'full-page')
                                       and a.captured_on > (l.layout_read->>'read_at')::timestamptz::date))) then
    return null;
  end if;
  return hopper.call_fn('hopper-design', jsonb_build_object('next', 2, 'write', true), 150000);
end $function$;
