-- HOP-18: bearer token for the hopper-mcp server.
-- The token is generated here, inside the database: the plain value goes only to Vault ('hopper_mcp_token'),
-- and hopper.settings keeps its sha256 for the function to check. Keith reads it from the Vault page
-- in the Supabase dashboard when adding the server to Claude Code. To rotate, run this block again.

do $$
declare
  t text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  existing uuid;
begin
  select id into existing from vault.secrets where name = 'hopper_mcp_token';
  if existing is null then
    perform vault.create_secret(t, 'hopper_mcp_token', 'Bearer token for the Hopper MCP server (hopper-mcp).');
  else
    perform vault.update_secret(existing, t);
  end if;
  insert into hopper.settings (key, value) values ('mcp_token_sha256', encode(sha256(t::bytea), 'hex'))
    on conflict (key) do update set value = excluded.value;
end $$;
