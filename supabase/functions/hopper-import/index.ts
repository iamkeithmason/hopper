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
//   3. POST { images: [...], pages: [...] } with the x-import-ticket header to record what was uploaded:
//      each image as an attachment with its page context (role, page address, caption, rendered size and
//      position at 1440), and each page as a link on the note (height, video count, capture date, layout read).
//      An image whose original_file is already on the note keeps its stored copy and design read and only
//      gains the context, so the same picture is never stored twice.
// Nothing else in the bucket can be written through this function, it never reads anything back, and a locked
// or binned note gets nothing.

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

// The note a ticket opens, or null if the ticket is unknown or expired.
async function ticketNote(req: Request) {
  const ticket = req.headers.get("x-import-ticket") ?? "";
  if (!/^[0-9a-f]{32}$/.test(ticket)) return null;
  const [row] = await sql`select value from hopper.settings where key = ${"import_ticket:" + (await sha256(ticket))}`;
  const [noteId, until] = String(row?.value ?? "").split("|");
  return row && Date.parse(until) > Date.now() ? noteId : null;
}

const ROLES = ["first-screen-1440", "first-screen-390", "full-page", "figure"];
const str = (v: unknown, n: number) => (v == null || v === "" ? null : String(v).slice(0, n));
const int = (v: unknown) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Math.round(Number(v)) : null);
const date = (v: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? "")) ? String(v) : null);
const web = (v: unknown) => (/^https?:\/\//i.test(String(v ?? "")) ? String(v).slice(0, 2000) : null);

async function record(noteId: string, b: any) {
  const images = Array.isArray(b.images) ? b.images.slice(0, 100) : [];
  const pages = Array.isArray(b.pages) ? b.pages.slice(0, 20) : [];
  let added = 0, annotated = 0, links = 0;
  for (const p of pages) {
    const url = web(p.url);
    if (!url) continue;
    // layout_read: an object describing the page as layout (first-screen UI share, widest figure, image treatment, motion).
    const layout = p.layout_read && typeof p.layout_read === "object" && JSON.stringify(p.layout_read).length < 8000 ? p.layout_read : null;
    await sql`insert into hopper.note_links (note_id, url, kind, page_title, page_height_px_at_1440, videos_on_page, captured_on, layout_read)
              values (${noteId}, ${url}, 'article', ${str(p.page_title, 300)}, ${int(p.page_height_px_at_1440)}, ${int(p.videos_on_page)},
                ${date(p.captured_on)}, ${layout ? sql.json(layout) : null})
              on conflict (note_id, url) do update set page_height_px_at_1440 = excluded.page_height_px_at_1440,
                videos_on_page = excluded.videos_on_page, captured_on = excluded.captured_on,
                layout_read = coalesce(excluded.layout_read, hopper.note_links.layout_read),
                page_title = coalesce(hopper.note_links.page_title, excluded.page_title)`;
    links++;
  }
  for (const im of images) {
    const name = String(im.name ?? "");
    const role = ROLES.includes(im.image_role) ? im.image_role : null;
    const original = str(im.original_file, 2000);
    if (!original) continue;
    const ctx = {
      caption: str(im.caption, 2000), role, page: web(im.source_page_url), onPage: str(im.caption_on_page, 2000),
      w: int(im.rendered_width_at_1440), h: int(im.rendered_height_at_1440), top: int(im.position_from_top_px_at_1440), on: date(im.captured_on),
    };
    // Already on the note (for example fetched earlier from the same address): add the context only.
    const upd = await sql`update hopper.attachments set caption = coalesce(${ctx.caption}, caption), image_role = ${ctx.role},
        source_page_url = ${ctx.page}, caption_on_page = ${ctx.onPage}, rendered_width_at_1440 = ${ctx.w},
        rendered_height_at_1440 = ${ctx.h}, position_from_top_px_at_1440 = ${ctx.top}, captured_on = ${ctx.on}
      where note_id = ${noteId} and original_file = ${original} returning id`;
    if (upd.length) { annotated++; continue; }
    if (!NAME.test(name)) continue;
    const path = `import/${noteId}/${name}`;
    const { data } = await storage.list(`import/${noteId}`, { search: name, limit: 1 });
    if (!data?.some((f: any) => f.name === name)) continue;
    await sql`insert into hopper.attachments (note_id, original_file, storage_path, mime, width, height, caption, image_role,
                source_page_url, caption_on_page, rendered_width_at_1440, rendered_height_at_1440, position_from_top_px_at_1440, captured_on)
              values (${noteId}, ${original}, ${path}, ${TYPES.includes(im.mime) ? im.mime : null}, ${int(im.width)}, ${int(im.height)},
                ${ctx.caption}, ${ctx.role}, ${ctx.page}, ${ctx.onPage}, ${ctx.w}, ${ctx.h}, ${ctx.top}, ${ctx.on})
              on conflict (note_id, original_file) do nothing`;
    added++;
  }
  return { added, annotated, pages: links };
}

Deno.serve(async (req: Request) => {
  try {
    if (req.method === "POST" && req.headers.get("x-import-ticket")) {
      const noteId = await ticketNote(req);
      if (!noteId) return new Response("forbidden", { status: 403 });
      if (!(await noteOpen(noteId))) return json({ error: "note not available" }, 404);
      return json(await record(noteId, await req.json().catch(() => ({}))));
    }
    if (req.method === "PUT") {
      const name = req.headers.get("x-import-name") ?? "";
      const type = (req.headers.get("content-type") ?? "").split(";")[0];
      const noteId = await ticketNote(req);
      if (!noteId) return new Response("forbidden", { status: 403 });
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
