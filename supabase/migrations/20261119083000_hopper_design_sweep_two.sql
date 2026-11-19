-- HOP-20: hopper-design now reads two images a call (more ran past the edge function's compute limit),
-- so the sweep asks for two. Same schedule: 10, 30 and 50 past each hour, so up to six new images an hour.

create or replace function hopper.design_sweep()
 returns bigint
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  if coalesce((select value from hopper.settings where key = 'auto_design'), 'off') <> 'on' then return null; end if;
  if not exists (select 1 from hopper.attachments a join hopper.notes_for_ai n on n.id = a.note_id
                 where a.storage_path is not null and n.tagged_at is not null and a.design_read is null) then return null; end if;
  return hopper.call_fn('hopper-design', jsonb_build_object('next', 2, 'write', true), 150000);
end $function$;
