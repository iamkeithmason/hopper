import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import postgres from "npm:postgres@3.4.4";
import { createClient } from "npm:@supabase/supabase-js@2";

// Hopper import: a way in for images captured outside Hopper (for example the portfolio benchmark captures,
// taken in a browser and handed over through Drive). Two steps:
//   1. POST { note_id } with the invoke token (in practice from the database, with hopper.call_fn, reading the
//      answer from net._http_response). Returns a ticket: a random code that lets its holder upload images to
//      import/<note_id>/ for two hours. Only its sha256 is kept (hopper.settings 'import_ticket:<hash>').
//   2. PUT the image bytes to this function with headers x-import-ticket and x-import-name (a file name such as
//      page--figure-01.png) and the image's content-type. The image is stored at import/<note_id>/<name>.
// The caller records the attachment rows itself. Nothing else in the bucket can be written through this
// function, it never reads anything back, and a locked or binned note gets nothing.

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2 });
const storage = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!).storage.from("hopper-images");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME = /^[a-z0-9][a-z0-9._-]{0,120}\.(jpg|jpeg|png|webp|gif)$/i;
const TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const HOURS = 2;

async function sha256(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

async function noteOpen(id: string) {
  const [n] = await sql`select is_locked, deleted_at from hopper.notes where id = ${id}`;
  return n && !n.is_locked && !n.deleted_at;
}

Deno.serve(async (req: Request) => {
  try {
    if (req.method === "PUT") {
      const ticket = req.headers.get("x-import-ticket") ?? "";
      const name = req.headers.get("x-import-name") ?? "";
      const type = (req.headers.get("content-type") ?? "").split(";")[0];
      if (!/^[0-9a-f]{32}$/.test(ticket)) return new Response("forbidden", { status: 403 });
      const [row] = await sql`select value from hopper.settings where key = ${"import_ticket:" + (await sha256(ticket))}`;
      const [noteId, until] = String(row?.value ?? "").split("|");
      if (!row || !(Date.parse(until) > Date.now())) return new Response("forbidden", { status: 403 });
      if (!NAME.test(name) || !TYPES.includes(type)) return json({ error: "name or content-type" }, 400);
      if (!(await noteOpen(noteId))) return json({ error: "note not available" }, 404);
      const bytes = new Uint8Array(await req.arrayBuffer());
      if (!bytes.length || bytes.length > 8_000_000) return json({ error: "size" }, 400);
      const path = `import/${noteId}/${name}`;
      const { error } = await storage.upload(path, bytes, { contentType: type, upsert: true });
      return error ? json({ error: error.message }, 500) : json({ path, bytes: bytes.length });
    }

    const [{ value: want }] = await sql`select value from hopper.settings where key = 'invoke_token_sha256'`;
    if ((await sha256(req.headers.get("x-hopper-token") ?? "")) !== want) return new Response("forbidden", { status: 403 });
    const b = await req.json().catch(() => ({}));
    const noteId = String(b.note_id ?? "");
    if (!UUID.test(noteId)) return json({ error: "note_id" }, 400);
    if (!(await noteOpen(noteId))) return json({ error: "note not available" }, 404);
    // Expired tickets are cleared whenever a new one is made.
    await sql`delete from hopper.settings where key like 'import_ticket:%' and split_part(value, '|', 2)::timestamptz < now()`;
    const ticket = [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, "0")).join("");
    const until = new Date(Date.now() + HOURS * 3600_000).toISOString();
    await sql`insert into hopper.settings (key, value) values (${"import_ticket:" + (await sha256(ticket))}, ${noteId + "|" + until})`;
    return json({ ticket, note_id: noteId, until });
  } catch (e) {
    return json({ error: String(e).slice(0, 300) }, 500);
  }
});
