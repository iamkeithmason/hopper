import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import postgres from "npm:postgres@3.4.4";
import { createClient } from "npm:@supabase/supabase-js@2";

// Hopper import slots: signed upload addresses for images captured outside Hopper (for example the portfolio
// benchmark captures, taken in a browser and handed over through Drive). The caller uploads each file with a
// PUT to its address within two hours, then records the attachment rows itself.
// Body: { note_id, names: ["file.jpg", ...] } (up to 40 names). Paths are import/<note_id>/<name>; nothing else
// in the bucket can be written through this function, and it never reads anything.
// Guarded by the hashed invoke token, so in practice it is called from the database with hopper.call_fn and
// its answer read from net._http_response.

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2 });
const storage = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!).storage.from("hopper-images");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME = /^[a-z0-9][a-z0-9._-]{0,120}\.(jpg|jpeg|png|webp|gif)$/i;

async function sha256(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

Deno.serve(async (req: Request) => {
  try {
    const [{ value: want }] = await sql`select value from hopper.settings where key = 'invoke_token_sha256'`;
    if ((await sha256(req.headers.get("x-hopper-token") ?? "")) !== want) return new Response("forbidden", { status: 403 });
    const b = await req.json().catch(() => ({}));
    const noteId = String(b.note_id ?? "");
    const names: string[] = Array.isArray(b.names) ? b.names.map(String) : [];
    if (!UUID.test(noteId)) return json({ error: "note_id" }, 400);
    if (!names.length || names.length > 40 || !names.every((n) => NAME.test(n))) return json({ error: "names" }, 400);
    const [n] = await sql`select is_locked, deleted_at from hopper.notes where id = ${noteId}`;
    if (!n || n.is_locked || n.deleted_at) return json({ error: "note not available" }, 404);
    const slots: Record<string, string> = {};
    for (const name of names) {
      const path = `import/${noteId}/${name}`;
      const { data, error } = await storage.createSignedUploadUrl(path, { upsert: true });
      if (error || !data) return json({ error: `${name}: ${error?.message ?? "no slot"}` }, 500);
      slots[path] = data.signedUrl;
    }
    return json({ slots });
  } catch (e) {
    return json({ error: String(e).slice(0, 300) }, 500);
  }
});
