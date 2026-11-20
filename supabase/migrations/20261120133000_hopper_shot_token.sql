-- Page screenshots (hopper-shot): token for hopper-api to call the screenshot function on the Vercel app.
-- Generated here, inside the database: the plain value goes only to Vault ('hopper_shot_token'), and
-- hopper.settings keeps its sha256, which is also what the Vercel project holds (SHOT_TOKEN_SHA256).
-- To rotate, run this block again and update SHOT_TOKEN_SHA256 on Vercel.

do $$
declare
  t text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  existing uuid;
begin
  select id into existing from vault.secrets where name = 'hopper_shot_token';
  if existing is null then
    perform vault.create_secret(t, 'hopper_shot_token', 'Token for hopper-api to call the page screenshot function (app/api/shot.js on Vercel).');
  else
    perform vault.update_secret(existing, t);
  end if;
  insert into hopper.settings (key, value) values ('shot_token_sha256', encode(sha256(t::bytea), 'hex'))
    on conflict (key) do update set value = excluded.value;
  insert into hopper.settings (key, value) values ('shot_url', 'https://hopper-keith.vercel.app/api/shot')
    on conflict (key) do update set value = excluded.value;
end $$;
