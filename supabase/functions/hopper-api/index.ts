import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import postgres from "npm:postgres@3.4.4";
import { createClient } from "npm:@supabase/supabase-js@2";

// Hopper's private API for the web app.
// Every request must carry a Supabase Auth access token for the owner's email (hopper.settings 'owner_email').
// Locked notes never return their body, summary or tags: only id, title, date and the lock.
// POST body: { action: "projects" | "topics" | "feed" | "search" | "note" | "capture" | "bin" | "restore" | "empty_bin" | "event", ... }
// "capture" also takes image_urls (fetched and kept by Hopper) and, from the invoke token only, source: "assistant".
// "note" also returns the note's aesthetic tags and, for images judged design references, their design read.
// Bin: "delete" moves a note to the Bin (deleted_at); the nightly hopper-bin job erases it after BIN_DAYS.
// Binned notes are hidden from the feed, search, related notes, projects and the AI, and can't be edited until restored.

const URL_ = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 3 });
const storage = createClient(URL_, SERVICE).storage.from("hopper-images");
// @ts-ignore Supabase global is provided by the edge runtime
const session = new Supabase.ai.Session("gte-small");
const BIN_DAYS = 7;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (d: unknown, status = 200) =>
  new Response(JSON.stringify(d), { status, headers: { ...CORS, "content-type": "application/json" } });
const IN_BIN = () => json({ error: "This note is in the Bin. Restore it first.", in_bin: true }, 409);
const erasesAt = (d: any) => (d ? new Date(new Date(d).getTime() + BIN_DAYS * 864e5).toISOString() : null);

async function sha256(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function owner(req: Request) {
  // Server-side callers (database jobs, tests) can use the Vault invoke token instead of a sign-in.
  const tok = req.headers.get("x-hopper-token");
  if (tok) {
    const [{ value: want }] = await sql`select value from hopper.settings where key = 'invoke_token_sha256'`;
    return (await sha256(tok)) === want ? { email: "service" } : null;
  }
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return null;
  const r = await fetch(`${URL_}/auth/v1/user`, { headers: { authorization: auth, apikey: ANON } });
  if (!r.ok) return null;
  const u = await r.json();
  const [row] = await sql`select value from hopper.settings where key = 'owner_email'`;
  if (!row || !u?.email || u.email.toLowerCase() !== row.value.toLowerCase()) return null;
  return u;
}

async function signed(paths: string[]) {
  const clean = paths.filter(Boolean);
  if (!clean.length) return {} as Record<string, string>;
  const { data } = await storage.createSignedUrls(clean, 3600);
  const out: Record<string, string> = {};
  for (const d of data ?? []) if (d.signedUrl && d.path) out[d.path] = d.signedUrl;
  return out;
}

// Erase binned notes for good, with their image files. Only touches notes already in the Bin.
async function erase(ids: string[]) {
  if (!ids.length) return 0;
  const atts = await sql`select a.storage_path from hopper.attachments a join hopper.notes n on n.id = a.note_id
                         where a.note_id = any(${sql.array(ids)}::uuid[]) and n.deleted_at is not null`;
  const gone = await sql`delete from hopper.notes where id = any(${sql.array(ids)}::uuid[]) and deleted_at is not null returning id`;
  const paths = atts.map((a: any) => a.storage_path).filter(Boolean);
  for (let i = 0; i < paths.length; i += 100) await storage.remove(paths.slice(i, i + 100));
  return gone.length;
}

// A note that is only a link (pasted into a new note, or shared without its own text) becomes a bookmark:
// the link is stored as a link, and its page's title, description and image are fetched so the note
// can be shown, searched and filed. Best-effort: a page that won't load just leaves the bare link.
const URL_RE = /https?:\/\/[^\s<>"']+/i;
const onlyUrl = (t: string | null) => (t && URL_RE.test(t) && t.replace(URL_RE, "").trim() === "" ? t.match(URL_RE)![0] : null);
const decode = (t: string) => t.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

// Video sites block plain page fetches from servers, so use their oEmbed endpoints instead.
const YT = /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/i;
const OEMBED: [RegExp, string, string][] = [
  [YT, "youtube", "https://www.youtube.com/oembed?format=json&url="],
  [/^https?:\/\/(?:www\.)?vimeo\.com\/(\d+)/i, "vimeo", "https://vimeo.com/api/oembed.json?url="],
];

// HOP: images behind links. Hopper keeps its own copy of the picture when a shared link is one: an image
// address (opened on its own in a browser tab, say), or a page on a picture site, where the page's preview
// image is the thing being saved. Picture-site links carry tokens or move, so a stored address can stop working.
// Article and video previews stay as links: their pictures are decoration, not what was saved.
const PICTURE_SITES = /(^|\.)(pinterest\.[a-z.]+|pin\.it|pinimg\.com|behance\.net|dribbble\.com|deviantart\.com|wixmp\.com|artstation\.com|are\.na|flickr\.com|unsplash\.com|instagram\.com|tumblr\.com|cosmos\.so|savee\.it)$/i;
const IMAGE_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
const MAX_IMAGE = 8_000_000;
const UA = "Mozilla/5.0 (compatible; Hopper/1.0; personal notes app)";
type Picture = { bytes: Uint8Array; mime: string; source: string };

const hostOf = (u: string) => { try { return new URL(u).hostname; } catch { return ""; } };
const pictureSite = (...urls: string[]) => urls.some((u) => PICTURE_SITES.test(hostOf(u)));

// The body of a response, if it is an image Claude can read and not too big. Otherwise null (and the body is let go).
async function readPicture(r: Response, source: string): Promise<Picture | null> {
  const mime = (r.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!r.ok || !IMAGE_TYPES[mime] || Number(r.headers.get("content-length") ?? 0) > MAX_IMAGE) { await r.body?.cancel(); return null; }
  const bytes = new Uint8Array(await r.arrayBuffer());
  return bytes.length && bytes.length <= MAX_IMAGE ? { bytes, mime, source } : null;
}

// Never ask for AVIF: image CDNs (Next.js, Cloudinary) serve it when asked, and Hopper can't store or read it.
async function fetchPicture(url: string, referer?: string): Promise<Picture | null> {
  try {
    const headers: Record<string, string> = { "user-agent": UA, accept: "image/webp,image/png,image/jpeg,image/gif;q=0.9,image/*;q=0.5" };
    if (referer) headers.referer = referer;
    const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(8000), headers });
    return await readPicture(r, url);
  } catch (_) { return null; }
}

// Width and height from the file header (JPEG, PNG, GIF, WebP), so the board can reserve the space. Null if unsure.
function pictureSize(b: Uint8Array): { width: number; height: number } | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  try {
    if (b[0] === 0x89 && b[1] === 0x50) return { width: v.getUint32(16), height: v.getUint32(20) };
    if (b[0] === 0x47 && b[1] === 0x49) return { width: v.getUint16(6, true), height: v.getUint16(8, true) };
    if (b[0] === 0x52 && b[8] === 0x57) {
      const kind = String.fromCharCode(b[12], b[13], b[14], b[15]);
      if (kind === "VP8 ") return { width: v.getUint16(26, true) & 0x3fff, height: v.getUint16(28, true) & 0x3fff };
      if (kind === "VP8L") { const x = v.getUint32(21, true); return { width: (x & 0x3fff) + 1, height: ((x >> 14) & 0x3fff) + 1 }; }
      if (kind === "VP8X") return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    }
    if (b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: v.getUint16(i + 7), height: v.getUint16(i + 5) };
        i += 2 + v.getUint16(i + 2);
      }
    }
  } catch (_) { /* unreadable header */ }
  return null;
}

// Store the picture as the note's image, unless the note already has images (shared files win).
// Safe to run again: the source address is the attachment's original_file, unique per note.
async function keepPicture(noteId: string, p: Picture) {
  const [{ c }] = await sql`select count(*)::int as c from hopper.attachments where note_id = ${noteId}`;
  if (c > 0) return false;
  const path = `link/${noteId}/0.${IMAGE_TYPES[p.mime]}`;
  const { error } = await storage.upload(path, p.bytes, { contentType: p.mime, upsert: true });
  if (error) return false;
  const size = pictureSize(p.bytes);
  const rows = await sql`insert into hopper.attachments (note_id, original_file, storage_path, mime, width, height)
            values (${noteId}, ${p.source}, ${path}, ${p.mime}, ${size?.width ?? null}, ${size?.height ?? null})
            on conflict (note_id, original_file) do nothing returning id`;
  return rows.length > 0;
}

type PageMeta = { url: string; title?: string; text?: string; image?: string; ok: boolean; kind?: string; provider?: string; media_id?: string; picture?: Picture };
async function pageMeta(url: string): Promise<PageMeta> {
  const out: PageMeta = { url, ok: false };
  try {
    for (const [re, provider, endpoint] of OEMBED) {
      const m = url.match(re);
      if (!m) continue;
      const canonical = provider === "youtube" ? `https://www.youtube.com/watch?v=${m[1]}` : url;
      const r = await fetch(endpoint + encodeURIComponent(canonical), { signal: AbortSignal.timeout(6000) });
      if (r.ok) {
        const j = await r.json();
        return { url, title: j.title, text: j.author_name ? `Video by ${j.author_name}` : undefined, image: j.thumbnail_url,
                 ok: true, kind: "video", provider, media_id: m[1] };
      }
    }
    const wiki = url.match(/^https?:\/\/([a-z]+)\.(?:m\.)?wikipedia\.org\/wiki\/([^?#]+)/i);
    if (wiki) {
      const r = await fetch(`https://${wiki[1]}.wikipedia.org/api/rest_v1/page/summary/${wiki[2]}`, { signal: AbortSignal.timeout(6000) });
      if (r.ok) {
        const j = await r.json();
        return { url, title: j.title, text: j.extract, image: j.thumbnail?.source, ok: true };
      }
    }
    const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(7000),
      headers: { "user-agent": UA, "accept-language": "en-GB,en;q=0.8" } });
    out.url = r.url || url;
    if (!r.ok) return out;
    if ((r.headers.get("content-type") ?? "").toLowerCase().startsWith("image/")) {
      // The link is the picture itself: keep it, and call the link fine even though there is no page.
      out.picture = (await readPicture(r, out.url)) ?? undefined;
      out.ok = Boolean(out.picture);
      if (out.picture) out.image = out.url;
      return out;
    }
    const html = (await r.text()).slice(0, 400000);
    const meta = (k: string) => {
      const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${k}["'][^>]*content=["']([^"']*)["']`, "i"))
        ?? html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${k}["']`, "i"));
      return m ? decode(m[1]) : undefined;
    };
    const tag = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    out.title = meta("og:title") ?? meta("twitter:title") ?? (tag ? decode(tag[1]) : undefined);
    out.text = meta("og:description") ?? meta("description") ?? meta("twitter:description");
    if (!out.text) {
      const para = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => decode(m[1].replace(/<[^>]+>/g, ""))).find((t) => t.length > 80);
      if (para) out.text = para.slice(0, 600);
    }
    out.image = meta("og:image") ?? meta("twitter:image");
    out.ok = Boolean(out.title || out.text);
  } catch (_) { /* leave the bare link */ }
  return out;
}

// Turn a bare-link note into a bookmark with its page details. Safe to run again on the same note.
// anySite: keep the page's preview image whatever the site (captures Claude makes for reference, where the page itself is the point).
async function linkify(id: string, anySite = false) {
  const [n] = await sql`select id, title, body, why_saved, summary, is_locked from hopper.notes where id = ${id}`;
  if (!n || n.is_locked) return;
  let [link] = await sql`select id, url, page_title from hopper.note_links where note_id = ${id} limit 1`;
  const fromBody = onlyUrl(n.body), fromWhy = onlyUrl(n.why_saved);
  const url = link?.url ?? fromBody ?? fromWhy ?? n.body?.match(URL_RE)?.[0] ?? n.why_saved?.match(URL_RE)?.[0];
  if (!url) return;
  if (!link) {
    [link] = await sql`insert into hopper.note_links (note_id, url) values (${id}, ${url}) on conflict (note_id, url) do update set url = excluded.url returning id, url, page_title`;
  }
  const m = await pageMeta(url);
  await sql`update hopper.note_links set
      page_title = coalesce(${m.title ?? null}::text, page_title),
      page_text = coalesce(${m.text ?? null}::text, page_text),
      thumbnail_url = coalesce(${m.image ?? null}::text, thumbnail_url),
      kind = coalesce(${m.kind ?? null}::text, kind), provider = coalesce(${m.provider ?? null}::text, provider),
      media_id = coalesce(${m.media_id ?? null}::text, media_id),
      fetched_at = now(), fetch_status = ${m.ok ? "ok" : "error"}
    where id = ${link.id}`;
  await sql`update hopper.notes set
      body = case when ${Boolean(fromBody)}::boolean then null else body end,
      why_saved = case when ${Boolean(fromWhy)}::boolean then null else why_saved end,
      title = coalesce(nullif(title, ''), ${m.title ?? null}::text),
      summary = coalesce(summary, left(${m.text ?? null}::text, 220)),
      format = case when ${Boolean(fromBody || fromWhy)}::boolean then coalesce(format, 'bookmark') else format end
    where id = ${id}`;
  // A picture behind the link becomes the note's own image. Best-effort: the bookmark stands either way.
  let pic: Picture | null = m.picture ?? null;
  if (!pic && m.image && (anySite || pictureSite(url, m.url))) {
    let src = m.image; try { src = new URL(m.image, m.url).href; } catch (_) { /* use as given */ }
    pic = await fetchPicture(src, m.url);
  }
  if (pic && await keepPicture(id, pic)) {
    // A link that was only ever the picture is an image note; the tagger and the design read look again with it.
    await sql`update hopper.notes set
        format = case when ${Boolean(m.picture)}::boolean and (format is null or format = 'bookmark') then 'image' else format end,
        tagged_at = null
      where id = ${id} and not is_locked`;
  }
}

// Embed an app-captured note with the same recipe as hopper-embed (title, why saved, link, body),
// then file it into projects by closeness to their anchor notes. Locked and binned notes are never embedded or filed.
async function embedAndFile(id: string, refile: boolean) {
  const [n] = await sql`
    select n.id, n.title, n.body, n.why_saved, n.is_locked, n.deleted_at,
      (select coalesce(l.page_title, l.url) from hopper.note_links l where l.note_id = n.id limit 1) as link,
      (select l.page_text from hopper.note_links l where l.note_id = n.id and l.page_text is not null limit 1) as link_text
    from hopper.notes n where n.id = ${id}`;
  if (!n || n.is_locked || n.deleted_at) return [];
  const text = [n.title, n.why_saved, n.link ? `Link: ${n.link}` : null, n.link_text ? String(n.link_text).slice(0, 800) : null,
    n.body ? String(n.body).slice(0, 1200) : null]
    .filter(Boolean).join("\n").slice(0, 1800);
  if (!text.trim()) return [];
  const vec = await embed(text);
  await sql`insert into hopper.note_embeddings (note_id, embedding, model) values (${id}, ${vec}::extensions.vector, 'gte-small')
            on conflict (note_id) do update set embedding = excluded.embedding, created_at = now()`;
  if (!refile) return [];
  return await sql`select project, band from hopper.file_note(${id})`;
}

// Who can unlock a note in the app: Keith's own locks, and safety-check locks on notes he captured
// himself (in the app, or clipped to Notion before Hopper existed), or asked Claude to save for him.
const OWN_CAPTURES = ["app", "notion-clip", "assistant"];
const canUnlock = (n: any) => n.lock_source === "user" || (OWN_CAPTURES.includes(n.source) && ["classifier", "pattern"].includes(n.lock_source));

// Card fields for lists. Locked notes are reduced to title, date and the lock.
// Binned notes also carry deleted_at and erases_at (the earliest time the nightly job erases them).
async function cards(rows: any[]) {
  const urls = await signed(rows.filter((r) => !r.is_locked).map((r) => r.image_path));
  return rows.map((r) => {
    const bin = r.deleted_at ? { deleted_at: r.deleted_at, erases_at: erasesAt(r.deleted_at) } : {};
    return r.is_locked
      ? { id: r.id, locked: true, title: r.title ?? null, created_at: r.created_at, user_locked: r.lock_source === "user", ...bin }
      : {
        id: r.id, locked: false, title: r.title, excerpt: r.excerpt, format: r.format, created_at: r.created_at,
        image: r.image_path ? urls[r.image_path] ?? null : (r.link_thumb ?? null),
        host: r.link_url ? String(r.link_url).replace(/^https?:\/\/(www\.)?/, "").split("/")[0] : null,
        projects: r.projects ?? [], score: r.score ?? undefined, pinned: !!r.pinned, color: r.keep_color ?? null, ...bin,
      };
  });
}

// Each palette colour with the share of the image it covers, from the measurement stored with the read.
function withShares(d: any) {
  const share = new Map((d.measured?.palette ?? []).map((m: any) => [String(m.hex).toLowerCase(), m.share]));
  return (d.palette ?? []).map((p: any) => ({ ...p, share: p.share ?? share.get(String(p.hex).toLowerCase()) ?? null }));
}

// The design read (from hopper-design) as the note page shows it: only for images judged design references.
function designFor(d: any) {
  if (!d?.is_reference) return null;
  return {
    kind: d.kind, summary: d.summary, palette: withShares(d), colour_notes: d.colour_notes || null,
    type: d.typography?.classification ?? [], families: (d.typography?.likely_families ?? []).map((f: any) => f.name),
    type_notes: d.typography?.hierarchy || null, layout: d.layout?.structure || null, density: d.density,
    components: d.components ?? [], techniques: d.techniques ?? [], mood: d.mood ?? [], era: d.era || null,
    good_for: d.good_reference_for ?? [], borrow: d.how_to_borrow || null,
  };
}

async function embed(text: string) {
  const v = await session.run(text, { mean_pool: true, normalize: true });
  return `[${Array.from(v as number[]).join(",")}]`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const user = await owner(req);
    if (!user) return json({ error: "not signed in as the owner" }, 401);
    const b = await req.json().catch(() => ({}));

    switch (b.action) {
      case "projects": {
        const rows = await sql`
          select p.id, p.name, count(n.id)::int as notes, max(n.created_at) as last_activity
          from hopper.projects p join hopper.note_projects np on np.project_id = p.id
          join hopper.notes n on n.id = np.note_id and not n.archived and n.deleted_at is null
          group by p.id, p.name order by max(n.created_at) desc`;
        return json({ projects: rows });
      }
      case "topics": {
        const rows = await sql`
          select t.name, count(*)::int as notes from hopper.note_topics nt
          join hopper.topics t on t.id = nt.topic_id
          join hopper.note_projects np on np.note_id = nt.note_id
          join hopper.notes n on n.id = nt.note_id and n.deleted_at is null
          where np.project_id = ${b.project_id} and t.name <> 'Unsorted'
          group by t.name order by count(*) desc limit 12`;
        return json({ topics: rows });
      }
      case "feed": {
        const limit = Math.min(Number(b.limit ?? 40), 80);
        const before = b.before ?? null;
        const project = b.project_id ?? null;
        const topic = b.topic ?? null;
        const archived = Boolean(b.archived);
        const pinned = b.pinned === undefined ? null : Boolean(b.pinned);
        const rows = await sql`
          select n.* from hopper.note_cards n
          where n.archived = ${archived} and n.deleted_at is null
            and (${pinned}::boolean is null or n.pinned = ${pinned}::boolean)
            and (${before}::timestamptz is null or n.created_at < ${before}::timestamptz)
            and (${project}::uuid is null or exists (select 1 from hopper.note_projects np where np.note_id = n.id and np.project_id = ${project}::uuid))
            and (${topic}::text is null or exists (select 1 from hopper.note_topics nt join hopper.topics t on t.id = nt.topic_id where nt.note_id = n.id and t.name = ${topic}::text))
          order by n.created_at desc limit ${limit}`;
        return json({ notes: await cards(rows) });
      }
      case "bin": {
        // Most recently binned first, in pages ({ offset, limit }). Includes locked notes (title and lock only).
        // Paged by offset, not by date: a bulk clear-out bins many notes with the same deleted_at.
        const limit = Math.min(Number(b.limit ?? 60), 100);
        const offset = Math.max(Number(b.offset ?? 0), 0);
        const rows = await sql`select n.* from hopper.note_cards n where n.deleted_at is not null
                               order by n.deleted_at desc, n.id limit ${limit} offset ${offset}`;
        const [{ total }] = await sql`select count(*)::int as total from hopper.notes where deleted_at is not null`;
        return json({ notes: await cards(rows), bin_days: BIN_DAYS, total });
      }
      case "search": {
        const q = String(b.q ?? "").trim();
        if (!q) return json({ notes: [] });
        const vec = await embed(q);
        const like = `%${q.replace(/[%_]/g, "")}%`;
        const rows = await sql`
          with sem as (
            select e.note_id, 1 - (e.embedding <=> ${vec}::extensions.vector) as score
            from hopper.note_embeddings e order by e.embedding <=> ${vec}::extensions.vector limit 40),
          kw as (
            select n.id as note_id, 1.0 as score from hopper.notes n
            where not n.is_locked and n.deleted_at is null and (n.title ilike ${like} or n.body ilike ${like}) limit 15),
          hits as (select note_id, max(score) + case when bool_or(note_id in (select note_id from kw)) then 0.03 else 0 end as score
                   from (select * from sem union all select * from kw) u group by note_id)
          select n.*, h.score from hits h join hopper.note_cards n on n.id = h.note_id
          where not n.is_locked and n.deleted_at is null order by h.score desc limit 40`;
        return json({ notes: await cards(rows) });
      }
      case "note": {
        const [n] = await sql`select * from hopper.notes where id = ${b.id}`;
        if (!n) return json({ error: "not found" }, 404);
        const bin = { deleted_at: n.deleted_at ?? null, erases_at: erasesAt(n.deleted_at) };
        if (n.is_locked) return json({ note: { id: n.id, locked: true, title: n.title, created_at: n.created_at, user_locked: n.lock_source === "user",
          can_unlock: canUnlock(n), lock_reason: n.lock_source === "user" ? null : n.lock_reason, ...bin } });
        const tags = await sql`
          select 'project' as kind, p.name, np.confidence, np.confirmed, np.added_by,
                 (select coalesce(nullif(r.title, ''), left(r.summary, 60)) from hopper.notes r where r.id = np.reason_note_id and not r.is_locked and r.deleted_at is null) as near
            from hopper.note_projects np join hopper.projects p on p.id = np.project_id where np.note_id = ${n.id}
          union all select 'topic', t.name, nt.confidence, null, null, null from hopper.note_topics nt join hopper.topics t on t.id = nt.topic_id where nt.note_id = ${n.id}
          union all select 'person', p.name, np.confidence, np.confirmed, null, null from hopper.note_people np join hopper.people p on p.id = np.person_id where np.note_id = ${n.id}
          union all select 'work', w.title, nw.confidence, null, null, null from hopper.note_works nw join hopper.works w on w.id = nw.work_id where nw.note_id = ${n.id}`;
        const links = await sql`select url, page_title, page_text, thumbnail_url from hopper.note_links where note_id = ${n.id}`;
        const atts = await sql`select storage_path, caption, design_read from hopper.attachments where note_id = ${n.id} order by id`;
        const urls = await signed(atts.map((a: any) => a.storage_path));
        const related = await sql`
          select n.*, 1 - (e2.embedding <=> e1.embedding) as score
          from hopper.note_embeddings e1 join hopper.note_embeddings e2 on e2.note_id <> e1.note_id
          join hopper.note_cards n on n.id = e2.note_id
          where e1.note_id = ${n.id} and not n.is_locked and n.deleted_at is null
          order by e2.embedding <=> e1.embedding limit 8`;
        return json({
          note: {
            id: n.id, locked: false, title: n.title, body: n.body, summary: n.summary, format: n.format,
            list_items: n.list_items, why_saved: n.why_saved, created_at: n.created_at, source: n.source,
            pinned: n.pinned, archived: n.archived, color: n.keep_color, edited_at: n.edited_at, ...bin,
            aesthetics: n.aesthetics ?? [],
            tags, links, images: atts.map((a: any) => ({ url: urls[a.storage_path] ?? null, caption: a.caption, design: designFor(a.design_read) })),
          },
          related: await cards(related),
        });
      }
      case "update": {
        // Title, body, format, colour, pin and archive. Locked and binned notes can't be edited here.
        const [n] = await sql`select id, is_locked, format, source, deleted_at from hopper.notes where id = ${b.id}`;
        if (!n) return json({ error: "not found" }, 404);
        if (n.deleted_at) return IN_BIN();
        if (n.is_locked) return json({ error: "locked" }, 403);
        const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k);
        const FORMATS = ["note", "list", "quote", "bookmark", "image", "scratch", "reference", "component"];
        const COLOURS = ["RED", "ORANGE", "YELLOW", "GREEN", "TEAL", "BLUE", "CERULEAN", "PURPLE", "PINK", "BROWN", "GRAY"];
        if (has("format") && b.format !== null && !FORMATS.includes(b.format)) return json({ error: "bad format" }, 400);
        if (has("color") && b.color !== null && !COLOURS.includes(b.color)) return json({ error: "bad colour" }, 400);
        const [u] = await sql`
          update hopper.notes set
            title = case when ${has("title")}::boolean then nullif(trim(${b.title ?? ""}::text), '') else title end,
            body = case when ${has("body")}::boolean then nullif(${b.body ?? ""}::text, '') else body end,
            format = case when ${has("format")}::boolean then ${b.format ?? null}::text else format end,
            keep_color = case when ${has("color")}::boolean then ${b.color ?? null}::text else keep_color end,
            pinned = case when ${has("pinned")}::boolean then ${Boolean(b.pinned)}::boolean else pinned end,
            archived = case when ${has("archived")}::boolean then ${Boolean(b.archived)}::boolean else archived end,
            edited_at = now()
          where id = ${b.id}
          returning id, edited_at, format, keep_color, pinned, archived`;
        if ((has("title") || has("body")) && OWN_CAPTURES.includes(n.source)) {
          // Marked for a fresh Claude tagging pass; the sweep runs it once the note has been still for two minutes.
          await sql`update hopper.notes set tagged_at = null where id = ${n.id} and not is_locked`;
          const [{ c }] = await sql`select count(*)::int as c from hopper.note_projects where note_id = ${n.id}`;
          try { await embedAndFile(n.id, c === 0); } catch (_) { /* best-effort */ }
        }
        if (has("format") && b.format !== n.format) {
          await sql`insert into hopper.corrections (note_id, facet, action, old_value, new_value) values (${n.id}, 'format', 'change', ${n.format}::text, ${b.format ?? null}::text)`;
        }
        return json({ note: u });
      }
      case "lock": {
        const lock = Boolean(b.lock);
        const [n] = await sql`select id, is_locked, lock_source, lock_reason, source, deleted_at from hopper.notes where id = ${b.id}`;
        if (!n) return json({ error: "not found" }, 404);
        if (n.deleted_at) return IN_BIN();
        // Keith can unlock his own locks, and safety-check locks on notes he captured in the app.
        // Safety-check locks on imported Keep notes wait for the master password.
        if (!lock && n.is_locked && !canUnlock(n)) return json({ error: "This note was locked by the safety check. It opens with the master password, which comes later." }, 403);
        await sql`update hopper.notes set is_locked = ${lock}::boolean, lock_source = ${lock ? "user" : null}::text,
                  lock_reason = ${lock ? "Locked by Keith" : null}::text, edited_at = now() where id = ${b.id}`;
        if (lock) await sql`delete from hopper.note_embeddings where note_id = ${b.id}`;
        if (!lock && n.is_locked && n.lock_source !== "user") {
          // Overruling the safety check: logged, never locked by it again, and tagged afresh.
          await sql`insert into hopper.corrections (note_id, facet, action, old_value, new_value)
                    values (${n.id}, 'lock', 'unlock', ${`${n.lock_source}: ${n.lock_reason ?? ""}`}::text, null)`;
          await sql`update hopper.notes set tagged_at = null where id = ${n.id}`;
        }
        if (!lock && n.is_locked) {
          const [{ c }] = await sql`select count(*)::int as c from hopper.note_projects where note_id = ${n.id}`;
          try { await embedAndFile(n.id, c === 0); } catch (_) { /* best-effort */ }
        }
        return json({ ok: true, locked: lock });
      }
      case "delete": {
        // Moves the note to the Bin. { forever: true } on a note already in the Bin erases it now.
        const [n] = await sql`select id, deleted_at from hopper.notes where id = ${b.id}`;
        if (!n) return json({ error: "not found" }, 404);
        if (b.forever) {
          if (!n.deleted_at) return json({ error: "Move the note to the Bin first." }, 409);
          await erase([n.id]);
          return json({ ok: true, erased: true });
        }
        if (n.deleted_at) return json({ ok: true, binned: true, deleted_at: n.deleted_at, erases_at: erasesAt(n.deleted_at) });
        const [u] = await sql`update hopper.notes set deleted_at = now() where id = ${n.id} returning deleted_at`;
        // Dropping the embedding takes it out of search, related notes and project anchors until restored.
        await sql`delete from hopper.note_embeddings where note_id = ${n.id}`;
        return json({ ok: true, binned: true, deleted_at: u.deleted_at, erases_at: erasesAt(u.deleted_at) });
      }
      case "restore": {
        const [n] = await sql`update hopper.notes set deleted_at = null where id = ${b.id} and deleted_at is not null returning id, is_locked`;
        if (!n) return json({ error: "not in the Bin" }, 404);
        if (!n.is_locked) { try { await embedAndFile(n.id, false); } catch (_) { /* search catches up on the next edit */ } }
        return json({ ok: true, restored: true });
      }
      case "empty_bin": {
        // Nightly job: erase notes binned more than BIN_DAYS ago. Keith can pass { all: true } to empty the whole Bin now.
        const all = Boolean(b.all) && user.email !== "service";
        const rows = all
          ? await sql`select id from hopper.notes where deleted_at is not null`
          : await sql`select id from hopper.notes where deleted_at < now() - make_interval(days => ${BIN_DAYS})`;
        const erased = await erase(rows.map((r: any) => r.id));
        return json({ ok: true, erased });
      }
      case "tag_options": {
        const projects = await sql`select name from hopper.projects order by name`;
        const topics = await sql`select name from hopper.topics where name <> 'Unsorted' order by name`;
        return json({ projects: projects.map((r: any) => r.name), topics: topics.map((r: any) => r.name) });
      }
      case "tag": {
        // kind: project | topic | person | work; op: add | remove | confirm
        const kind = String(b.kind), op = String(b.op), name = String(b.name ?? "").trim();
        const [n] = await sql`select id, is_locked, deleted_at from hopper.notes where id = ${b.id}`;
        if (!n || n.is_locked) return json({ error: "not available" }, 404);
        if (n.deleted_at) return IN_BIN();
        const T: Record<string, { link: string; ref: string; tbl: string; col: string }> = {
          project: { link: "note_projects", ref: "project_id", tbl: "projects", col: "name" },
          topic: { link: "note_topics", ref: "topic_id", tbl: "topics", col: "name" },
          person: { link: "note_people", ref: "person_id", tbl: "people", col: "name" },
          work: { link: "note_works", ref: "work_id", tbl: "works", col: "title" },
        };
        const t = T[kind];
        if (!t || !name) return json({ error: "bad tag" }, 400);
        const [ref] = await sql`select id from ${sql("hopper." + t.tbl)} where ${sql(t.col)} = ${name} limit 1`;
        if (op === "add") {
          if (!ref) return json({ error: `No ${kind} called ${name}` }, 400);
          if (kind === "topic") await sql`insert into hopper.note_topics (note_id, topic_id, confidence) values (${n.id}, ${ref.id}, 'high') on conflict do nothing`;
          else if (kind === "project") {
            await sql`insert into hopper.note_projects (note_id, project_id, confidence, confirmed, added_by) values (${n.id}, ${ref.id}, 'high', true, 'keith')
                      on conflict (note_id, project_id) do update set confirmed = true, confidence = 'high'`;
            await sql`delete from hopper.tag_rejections where note_id = ${n.id} and project_id = ${ref.id}`;
          }
          else return json({ error: "add people and works later" }, 400);
        } else if (op === "remove") {
          if (!ref) return json({ error: "not found" }, 404);
          await sql`delete from ${sql("hopper." + t.link)} where note_id = ${n.id} and ${sql(t.ref)} = ${ref.id}`;
          if (kind === "project") await sql`insert into hopper.tag_rejections (note_id, project_id) values (${n.id}, ${ref.id}) on conflict do nothing`;
        } else if (op === "confirm") {
          if (!ref) return json({ error: "not found" }, 404);
          if (kind === "topic" || kind === "work") await sql`update ${sql("hopper." + t.link)} set confidence = 'high' where note_id = ${n.id} and ${sql(t.ref)} = ${ref.id}`;
          else await sql`update ${sql("hopper." + t.link)} set confirmed = true, confidence = 'high' where note_id = ${n.id} and ${sql(t.ref)} = ${ref.id}`;
        } else return json({ error: "bad op" }, 400);
        await sql`insert into hopper.corrections (note_id, facet, action, old_value, new_value)
                  values (${n.id}, ${kind}, ${op}, ${op === "add" ? null : name}::text, ${op === "remove" ? null : name}::text)`;
        return json({ ok: true });
      }
      case "capture": {
        const title = (b.title ?? "").trim() || null;
        const text = (b.text ?? "").trim() || null;
        const url = (b.url ?? "").trim() || null;
        const why = (b.note ?? "").trim() || null;
        // HOP-7: up to four shared images, already shrunk to JPEG by the app.
        const images = (Array.isArray(b.images) ? b.images : []).slice(0, 4)
          .filter((im: any) => typeof im?.data === "string" && im.data.length < 4_000_000);
        // Image addresses for Hopper to fetch and keep (hopper-mcp's save tool: Claude can see a page's pictures but not hand over their bytes).
        const imageUrls: string[] = (Array.isArray(b.image_urls) ? b.image_urls : [])
          .map((u: unknown) => String(u ?? "").trim()).filter((u: string) => /^https?:\/\//i.test(u)).slice(0, 4 - images.length);
        if (!title && !text && !url && !why && !images.length && !imageUrls.length) return json({ error: "nothing to save" }, 400);
        // Only trusted server-side callers (hopper-mcp) may mark a note as saved by Claude; everything else is the app.
        const source = user.email === "service" && b.source === "assistant" ? "assistant" : "app";
        const lock = Boolean(b.lock);
        const [n] = await sql`
          insert into hopper.notes (source, title, body, why_saved, is_locked, lock_source, lock_reason, format)
          values (${source}, ${title}, ${text}, ${why}, ${lock}, ${lock ? "user" : null}, ${lock ? "Locked at capture" : null},
                  ${(images.length || imageUrls.length) && !url && !text ? "image" : null})
          returning id, created_at`;
        if (url) await sql`insert into hopper.note_links (note_id, url, page_title) values (${n.id}, ${url}, ${title})`;
        for (const [i, im] of images.entries()) {
          const path = `app/${n.id}/${i}.jpg`;
          const bytes = Uint8Array.from(atob(im.data), (c) => c.charCodeAt(0));
          const { error } = await storage.upload(path, bytes, { contentType: "image/jpeg", upsert: true });
          if (error) continue;
          await sql`insert into hopper.attachments (note_id, storage_path, mime, width, height)
                    values (${n.id}, ${path}, 'image/jpeg', ${Number(im.width) || null}, ${Number(im.height) || null})`;
        }
        let fetched = 0;
        for (const [i, src] of imageUrls.entries()) {
          const p = await fetchPicture(src, url ?? undefined);
          if (!p) continue;
          const path = `link/${n.id}/${images.length + i}.${IMAGE_TYPES[p.mime]}`;
          const { error } = await storage.upload(path, p.bytes, { contentType: p.mime, upsert: true });
          if (error) continue;
          const size = pictureSize(p.bytes);
          const rows = await sql`insert into hopper.attachments (note_id, original_file, storage_path, mime, width, height)
                    values (${n.id}, ${p.source}, ${path}, ${p.mime}, ${size?.width ?? null}, ${size?.height ?? null})
                    on conflict (note_id, original_file) do nothing returning id`;
          fetched += rows.length;
        }
        try { await linkify(n.id, source === "assistant"); } catch (_) { /* the note is saved either way */ }
        let filed: any[] = [];
        try { filed = await embedAndFile(n.id, true); } catch (_) { /* filing is best-effort; the note is saved either way */ }
        // Claude tagging runs in the background once filing is done (HOP-5); it does nothing while auto_tag is off.
        try { await sql`select hopper.tag_new(${n.id}::uuid)`; } catch (_) { /* the sweep picks it up */ }
        const [{ c: stored }] = await sql`select count(*)::int as c from hopper.attachments where note_id = ${n.id}`;
        const [{ t }] = await sql`select title as t from hopper.notes where id = ${n.id}`;
        return json({ saved: { ...n, title: t }, filed, images: stored, image_urls_kept: fetched });
      }
      case "relink": {
        // Repair a note saved before links were recognised: linkify, re-embed and file if it has no projects.
        const [n] = await sql`select id, source, deleted_at from hopper.notes where id = ${b.id}`;
        if (!n || !OWN_CAPTURES.includes(n.source)) return json({ error: "not available" }, 404);
        if (n.deleted_at) return IN_BIN();
        await linkify(n.id);
        const [{ c }] = await sql`select count(*)::int as c from hopper.note_projects where note_id = ${n.id}`;
        const filed = await embedAndFile(n.id, c === 0);
        return json({ ok: true, filed });
      }
      case "event": {
        // Silent navigation count (hopper.ui_events), for deciding where the project pills live.
        const EVENTS = ["open", "pill", "sheet", "sheet_pick", "topic"];
        if (!EVENTS.includes(b.event)) return json({ error: "bad event" }, 400);
        const device = b.device === "phone" || b.device === "desktop" ? b.device : null;
        const topic = typeof b.topic === "string" ? b.topic.slice(0, 80) : null;
        await sql`insert into hopper.ui_events (event, project_id, topic, device)
                  values (${b.event}, ${b.project_id ?? null}::uuid, ${topic}, ${device})`;
        return json({ ok: true });
      }
      default:
        return json({ error: "unknown action" }, 400);
    }
  } catch (e) {
    return json({ error: String(e).slice(0, 300) }, 500);
  }
});
