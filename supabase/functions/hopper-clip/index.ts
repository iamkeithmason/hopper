import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import postgres from "npm:postgres@3.4.4";

// Hopper clipper gateway (HOP-8), for the Chrome/Brave extension.
// The extension holds a capture-only token (Vault 'hopper_capture_token'; its sha256 in hopper.settings
// 'capture_token_sha256'). This function checks it and passes captures on to hopper-api unchanged, so the
// token can save notes but never read them. hopper-api does all the saving, linking, embedding and filing.
// Body: { action: "ping" } to test the token, or { action: "capture", title?, text?, url?, note?, images?, lock? }.

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2 });
const API = `${Deno.env.get("SUPABASE_URL")}/functions/v1/hopper-api`;

async function sha256(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

Deno.serve(async (req: Request) => {
  try {
    if (req.method !== "POST") return json({ error: "POST only" }, 405);
    const auth = req.headers.get("authorization") ?? "";
    const [row] = await sql`select value from hopper.settings where key = 'capture_token_sha256'`;
    if (!row || !auth.startsWith("Bearer ") || (await sha256(auth.slice(7).trim())) !== row.value) {
      return json({ error: "That capture token isn't right. Copy it again from Vault (hopper_capture_token)." }, 401);
    }
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ error: "bad request" }, 400);
    if (body.action === "ping") return json({ ok: true });
    if (body.action !== "capture") return json({ error: "The capture token can only save." }, 403);

    // The invoke token lets hopper-api treat this as a trusted server-side caller; it never leaves the server.
    const [{ tok }] = await sql`select decrypted_secret as tok from vault.decrypted_secrets where name = 'hopper_invoke_token'`;
    const { title, text, url, note, images, lock } = body;
    const r = await fetch(API, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hopper-token": tok },
      // HOP-43: hopper-api records the route and the device, from the browser's user agent.
      body: JSON.stringify({ action: "capture", title, text, url, note, images, lock,
        route: "extension", user_agent: req.headers.get("user-agent") ?? "" }),
    });
    return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
  } catch (e) {
    return json({ error: String(e).slice(0, 300) }, 500);
  }
});
