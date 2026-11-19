-- HOP-20: read new images automatically with hopper-design.
-- Runs ten minutes after each tagging sweep, so new captures have had the sensitive check first
-- (hopper-design itself only reads notes with tagged_at set). Switch: settings.auto_design ('on' or 'off').
-- Six images a run at about $0.03 each (Opus 5.5).

insert into hopper.settings (key, value) values ('auto_design', 'on')
  on conflict (key) do update set value = excluded.value;

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
  return hopper.call_fn('hopper-design', jsonb_build_object('next', 6, 'write', true), 150000);
end $function$;

revoke all on function hopper.design_sweep() from public, anon, authenticated;

select cron.schedule('hopper-design-sweep', '10,30,50 * * * *', 'select hopper.design_sweep()');
