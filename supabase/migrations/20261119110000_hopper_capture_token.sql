-- HOP-8: capture-only token for the Chrome/Brave extension (via the hopper-clip function).
-- Generated here, inside the database: the plain value goes only to Vault ('hopper_capture_token'), and
-- hopper.settings keeps its sha256. Keith copies it from the Vault page into the extension's options once.
-- To rotate, run this block again (the extension then needs the new token).

do $$
declare
  t text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  existing uuid;
begin
  select id into existing from vault.secrets where name = 'hopper_capture_token';
  if existing is null then
    perform vault.create_secret(t, 'hopper_capture_token', 'Capture-only token for the Hopper browser extension (hopper-clip).');
  else
    perform vault.update_secret(existing, t);
  end if;
  insert into hopper.settings (key, value) values ('capture_token_sha256', encode(sha256(t::bytea), 'hex'))
    on conflict (key) do update set value = excluded.value;
end $$;
