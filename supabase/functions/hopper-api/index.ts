import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import postgres from "npm:postgres@3.4.4";
import { createClient } from "npm:@supabase/supabase-js@2";
import { decodeBase64 } from "jsr:@std/encoding@1/base64";

// Hopper's private API for the web app.
// Every request must carry a Supabase Auth access token for the owner's email (hopper.settings 'owner_email').
// Locked notes never return their body, summary or tags: only id, title, date and the lock.
// "pin_project" { project_id, pinned } pins a project pill to the front of the row (HOP-13).
// POST body: { action: "projects" | "topics" | "feed" | "search" | "note" | "capture" | "bin" | "restore" | "empty_bin" | "event", ... }
// "capture" also takes, from the invoke token only, projects: exact project names to file the note in (hopper-mcp).
// "capture" records its route (HOP-43): route "share" or "new" from the app, "extension" (with the browser's user_agent)
// from hopper-clip, "mcp" for source "assistant"; capture_device comes from the user agent.
// "capture" also takes image_urls (fetched and kept by Hopper), screenshot (first screen and whole page of the url,
// from the screenshot function on the Vercel app) and, from the invoke token only, source: "assistant".
// "screenshot" { id, url?, views? } adds page screenshots to an existing note (its link, or another page as a new link), or retakes them.
// "prune_shots" (invoke token only) removes screenshot files no attachment points at.
// "hash_images" (invoke token only) fills content_sha256 for images stored before byte dedupe, 25 a call.
// "capture" also takes transcript (and transcript_language) for a video url, read off the page by the extension (HOP-61);
// hopper-transcript summarises it in the background. "note" returns each link's transcript_summary.
// "note" also returns the note's aesthetic tags and, for images judged design references, their design read.
// Bin: "delete" moves a note to the Bin (deleted_at); the nightly hopper-bin job erases it after BIN_DAYS.
// Binned notes are hidden from the feed, search, related notes, projects and the AI, and can't be edited until restored.
// "refetch" { id } reads a note's page again, plainly and then in a real browser (HOP-50); "add_images" { id, images }
// adds pictures to a saved note. Captures whose page refuses the fetch get the same browser rescue in the background.
// "measure" { id, url? } measures a captured page's motion and type (HOP-55, 56, 57); desktop captures do it in the background.

const URL_ = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 3 });
const storage = createClient(URL_, SERVICE).storage.from("hopper-images");
// @ts-ignore Supabase global is provided by the edge runtime
const session = new Supabase.ai.Session("gte-small");
const BIN_DAYS = 7;
const TRANSCRIPT_MAX = 400_000; // characters of a video transcript kept (HOP-61); about five hours of speech

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (d: unknown, status = 200) =>
  new Response(JSON.stringify(d), { status, headers: { ...CORS, "content-type": "application/json" } });
const IN_BIN = () => json({ error: "This note is in the Bin. Restore it first.", in_bin: true }, 409);
const erasesAt = (d: any) => (d ? new Date(new Date(d).getTime() + BIN_DAYS * 864e5).toISOString() : null);

// The sha256 of an image's bytes (attachments.content_sha256): the same picture is kept once per note, whatever address
// it came from. Screenshots are hashed too but never skipped: each is its own capture.
async function bytesHash(b: Uint8Array) {
  const d = await crypto.subtle.digest("SHA-256", b as BufferSource);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function sameOnNote(noteId: string, hash: string) {
  const [row] = await sql`select id, image_role from hopper.attachments where note_id = ${noteId} and content_sha256 = ${hash} limit 1`;
  return row ?? null;
}

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
  const rows = await sql`insert into hopper.attachments (note_id, original_file, storage_path, mime, width, height, content_sha256)
            values (${noteId}, ${p.source}, ${path}, ${p.mime}, ${size?.width ?? null}, ${size?.height ?? null}, ${await bytesHash(p.bytes)})
            on conflict (note_id, original_file) do nothing returning id`;
  return rows.length > 0;
}

type PageMeta = { url: string; title?: string; text?: string; image?: string; ok: boolean; kind?: string; provider?: string; media_id?: string; picture?: Picture; status?: number };

// HOP-50: tracking parameters say nothing about the page, and some sites refuse odd query strings, so they are
// dropped before fetching (the saved address keeps them). A page that refuses Hopper is asked once more as a browser.
const TRACKING = /^(utm_.*|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|igsh|_hsenc|_hsmi|ref_src|si)$/i;
function cleanUrl(u: string) {
  try {
    const x = new URL(u);
    for (const k of [...x.searchParams.keys()]) if (TRACKING.test(k)) x.searchParams.delete(k);
    return x.href;
  } catch { return u; }
}
const BROWSER_HEADERS = {
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "accept-language": "en-GB,en;q=0.9",
};
// Sign-in walls and bot checks: a page whose title says so wasn't really read.
const WALL = /just a moment|attention required|access denied|are you a (robot|human)|verify you are human|captcha|forbidden|\b403\b|security check|^(log|sign) ?in\b/i;
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
    const target = cleanUrl(url);
    let r = await fetch(target, { redirect: "follow", signal: AbortSignal.timeout(7000),
      headers: { "user-agent": UA, "accept-language": "en-GB,en;q=0.8" } });
    if (!r.ok && r.status !== 404 && r.status !== 410) {
      await r.body?.cancel();
      r = await fetch(target, { redirect: "follow", signal: AbortSignal.timeout(7000), headers: BROWSER_HEADERS });
    }
    out.url = r.url || url;
    out.status = r.status;
    if (!r.ok) { await r.body?.cancel(); return out; }
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

// Search weights (HOP-34, the same as hopper-mcp's): a keyword hit adds this to the semantic score, by the best field
// it lands in. Semantic-only hits under SEM_FLOOR are left out: gte-small scores noise at 0.80 to 0.82 (Keith chose 0.82).
const KW = { title: 0.2, tag: 0.15, summary: 0.1, body: 0.05 };
const SEM_FLOOR = 0.82;
// A case-insensitive whole-word pattern for the query (Postgres \m and \M mark word starts and ends).
function wordPattern(q: string) {
  const body = q.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&").replace(/\s+/g, "\\s+");
  return `${/^\w/.test(q) ? "\\m" : ""}${body}${/\w$/.test(q) ? "\\M" : ""}`;
}

// Turn a bare-link note into a bookmark with its page details. Safe to run again on the same note.
// anySite: keep the page's preview image whatever the site (captures Claude makes for reference, where the page itself is the point).
// Returns whether the page was read, and the link it tried.
const BLOCKED = [401, 403, 429, 451, 503, 999];
async function linkify(id: string, anySite = false): Promise<{ ok: boolean; linkId: string; url: string } | undefined> {
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
      fetched_at = now(), fetch_status = ${m.ok ? "ok" : BLOCKED.includes(m.status ?? 0) ? "blocked" : "error"}
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
  return { ok: m.ok, linkId: link.id, url };
}

// HOP-50: a page that refuses Hopper's fetch is opened in the screenshot service's real browser instead. Its title,
// description and preview image are read off the live page, and the first screen becomes the note's picture when the
// page has no preview image of its own (and the note no picture). The link's fetch_status becomes 'browser'. When that
// fails too the link keeps its failed status, and the open note says it couldn't read the page.
async function rescue(id: string, linkId: string, url: string) {
  if (!/^https?:\/\//i.test(url)) return false;
  const [n] = await sql`select is_locked, deleted_at from hopper.notes where id = ${id}`;
  if (!n || n.is_locked || n.deleted_at) return false;
  const shot = await takeShot(cleanUrl(url), ["first-screen-1440"], false);
  if ("error" in shot || (shot.status ?? 200) >= 400 || !shot.first || WALL.test(shot.title ?? "")) return false;
  const desc = shot.meta?.description?.trim() || null;
  const title = shot.title?.trim() || null;
  await sql`update hopper.note_links set page_title = coalesce(page_title, ${title}::text), page_text = coalesce(page_text, ${desc}::text),
              thumbnail_url = coalesce(thumbnail_url, ${shot.meta?.image ?? null}::text), fetch_status = 'browser', fetched_at = now()
            where id = ${linkId}`;
  await sql`update hopper.notes set title = coalesce(nullif(title, ''), ${title}::text), summary = coalesce(summary, left(${desc}::text, 220))
            where id = ${id} and not is_locked`;
  let pic: Picture | null = shot.meta?.image ? await fetchPicture(shot.meta.image, url) : null;
  if (!pic) pic = { bytes: decodeBase64(shot.first), mime: "image/jpeg", source: `rescue:${url}#first-screen-1440` };
  if (await keepPicture(id, pic)) await sql`update hopper.notes set tagged_at = null where id = ${id} and not is_locked`;
  try { await embedAndFile(id, false); } catch (_) { /* search catches up on the next edit */ }
  return true;
}

// Work that carries on after the reply (EdgeRuntime.waitUntil), so a slow rescue never holds up a save.
function background(p: Promise<unknown>) {
  const q = p.catch((e) => console.error("background", String(e).slice(0, 200)));
  // @ts-ignore EdgeRuntime is provided by the Supabase edge runtime
  try { EdgeRuntime.waitUntil(q); } catch (_) { /* it still runs while the worker lives */ }
}

// Page screenshots (hopper-shot): the Vercel app's /api/shot renders the page in headless Chrome and returns the
// first screen (1440 x 900), the whole page (scaled to fit 8000 px) and the first screen on a phone (390 x 844 at 2x)
// as JPEGs (the whole page stitched from scroll frames), plus the page's six largest figures and its video count.
// views limits what is taken: desktop (first screen and whole page) and phone. The token is in Vault ('hopper_shot_token').
type Figure = { src: string; alt?: string; caption?: string; width: number; height: number; top: number };
type Shot = { first: string | null; full: string | null; phone: string | null; width: number; height: number; full_height: number | null; full_scale?: number; clipped: boolean; title: string | null;
  figures?: Figure[]; videos?: number | null; motion?: { where: string; top: number; image: string; changed_pct: number }[];
  status?: number | null; meta?: { image?: string | null; description?: string | null } | null };
const ROLES = ["first-screen-1440", "full-page", "first-screen-390"];
async function takeShot(url: string, roles = ROLES, motion = true): Promise<Shot | { error: string }> {
  try {
    const [cfg] = await sql`select (select value from hopper.settings where key = 'shot_url') as shot_url,
      (select decrypted_secret from vault.decrypted_secrets where name = 'hopper_shot_token') as tok`;
    if (!cfg?.shot_url || !cfg?.tok) return { error: "screenshots aren't set up" };
    const r = await fetch(cfg.shot_url, {
      method: "POST", signal: AbortSignal.timeout(75000),
      headers: { "content-type": "application/json", "x-shot-token": cfg.tok },
      body: JSON.stringify({ url, desktop: roles.some((x) => x !== "first-screen-390"), full: roles.includes("full-page"),
                             phone: roles.includes("first-screen-390"), motion }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !(j.first || j.phone)) return { error: j.error ? `${j.error}${j.stage ? ` (${j.stage})` : ""}` : `screenshot ${r.status}` };
    return j as Shot;
  } catch (e) { return { error: `screenshot: ${String(e).slice(0, 120)}` }; }
}

// HOP-55, 56, 57: the page measured in the capture browser, in two calls side by side (each has its own 60 seconds):
// motion (what moves, how long, which easing, how far, staggers, load or scroll, what reduced motion keeps, which
// library) and type (text treatments with their roles, and icon sizes, at 1440 and 390). Both go on the page's link
// (note_links.motion, type_scale). Strips of the entrance and the first scroll reveal join the page's motion strips.
// Measurements cost no model credit. Locked and binned notes are left alone.
async function shotCall(body: Record<string, unknown>) {
  const [cfg] = await sql`select (select value from hopper.settings where key = 'shot_url') as shot_url,
    (select decrypted_secret from vault.decrypted_secrets where name = 'hopper_shot_token') as tok`;
  if (!cfg?.shot_url || !cfg?.tok) return { error: "screenshots aren't set up" };
  try {
    const r = await fetch(cfg.shot_url, { method: "POST", signal: AbortSignal.timeout(75000),
      headers: { "content-type": "application/json", "x-shot-token": cfg.tok }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    return r.ok ? j : { error: j.error ?? `measure ${r.status}` };
  } catch (e) { return { error: `measure: ${String(e).slice(0, 120)}` }; }
}
async function measurePage(noteId: string, pageUrl: string) {
  const [n] = await sql`select is_locked, deleted_at from hopper.notes where id = ${noteId}`;
  if (!n || n.is_locked || n.deleted_at) return { error: "not available" };
  const [motion, type] = await Promise.all([shotCall({ url: pageUrl, measure: "motion" }), shotCall({ url: pageUrl, measure: "type" })]);
  const out: Record<string, unknown> = {};
  if (!motion.error && motion.motion) {
    await sql`update hopper.note_links set motion = ${sql.json(motion.motion)} where note_id = ${noteId} and url = ${pageUrl}`;
    out.motion = true;
    const stem = `${slugOf(pageUrl)}-${(await sha256(pageUrl)).slice(0, 6)}`;
    const names: Record<string, string> = { "first screen as it loads": "entrance", "first scroll reveal": "scroll-reveal" };
    const keep: string[] = [];
    for (const m of (motion.strips ?? []) as any[]) {
      const tag = names[m.where];
      if (!tag || typeof m.image !== "string") continue;
      const bytes = decodeBase64(m.image);
      const path = `shot/${noteId}/${stem}--motion-${tag}.jpg`;
      const { error } = await storage.upload(path, bytes, { contentType: "image/jpeg", upsert: true });
      if (error) continue;
      const size = pictureSize(bytes);
      const original = `capture:${pageUrl}#motion-${tag}`;
      const caption = tag === "entrance"
        ? `three frames of the first screen as it loads, 0, 0.6 and 1.5 seconds after it appears, left to right (${m.changed_pct}% of the view changes)`
        : `three frames of the first scroll reveal, 0, 0.4 and 0.9 seconds after scrolling to ${m.top} px, left to right (${m.changed_pct}% of the view changes)`;
      await sql`insert into hopper.attachments (note_id, original_file, storage_path, mime, width, height, caption,
                  image_role, source_page_url, position_from_top_px_at_1440, captured_on, content_sha256)
                values (${noteId}, ${original}, ${path}, 'image/jpeg', ${size?.width ?? null}, ${size?.height ?? null}, ${caption},
                  'motion-strip', ${pageUrl}, ${m.top}, current_date, ${await bytesHash(bytes)})
                on conflict (note_id, original_file) do update set storage_path = excluded.storage_path, width = excluded.width,
                  height = excluded.height, caption = excluded.caption, position_from_top_px_at_1440 = excluded.position_from_top_px_at_1440,
                  captured_on = excluded.captured_on, content_sha256 = excluded.content_sha256, design_read = null`;
      keep.push(original);
    }
    // A page that no longer moves on entry or on scroll loses its old strip of that kind.
    const gone = await sql`delete from hopper.attachments where note_id = ${noteId} and source_page_url = ${pageUrl}
                             and original_file in (${`capture:${pageUrl}#motion-entrance`}, ${`capture:${pageUrl}#motion-scroll-reveal`})
                             and not (original_file = any(${keep}::text[])) returning storage_path`;
    const paths = gone.map((g: any) => g.storage_path).filter(Boolean);
    if (paths.length) await storage.remove(paths);
    out.strips = keep.length;
  } else out.motion_error = motion.error ?? "no motion reading";
  if (!type.error && type.type_scale) {
    await sql`update hopper.note_links set type_scale = ${sql.json(type.type_scale)} where note_id = ${noteId} and url = ${pageUrl}`;
    out.type = true;
  } else out.type_error = type.error ?? "no type reading";
  return out;
}

// Tall pages come back scaled down (to fit the 8000 px image limit), and past 40% cut short.
function fullCaption(s: Shot) {
  const pct = s.full_scale && s.full_scale < 1 ? `, at ${Math.round(s.full_scale * 100)}% size` : "";
  return s.clipped ? `Top of the page${pct} (the page is ${s.full_height} px tall)` : `Whole page${pct}`;
}

// Store a page's screenshots on a note, keyed by page, so one note can hold several pages (a portfolio's home, a case
// study, an about page). Same scheme as hopper-import: original_file 'capture:<page>#<role>', with the image role, the
// page address and the capture date, so list_benchmarks and get_reference treat both kinds of capture alike.
// Taking a page again replaces its files and clears their design reads. The page also goes on the note as a link,
// with its height at 1440 and the capture date.
const slugOf = (u: string) => {
  try {
    const last = new URL(u).pathname.split("/").filter(Boolean).pop() ?? "home";
    return last.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "home";
  } catch { return "page"; }
};
async function keepShots(noteId: string, shot: Shot, pageUrl: string) {
  const stem = `${slugOf(pageUrl)}-${(await sha256(pageUrl)).slice(0, 6)}`;
  const parts: [string, string | null, string, number, number | null][] = [
    ["first-screen-1440", shot.first, `First screen at ${shot.width} x ${shot.height}`, shot.width, shot.height],
    ["full-page", shot.full, fullCaption(shot), shot.width, shot.full_height],
    ["first-screen-390", shot.phone, "First screen on a phone, 390 x 844 at 2x", 780, 1688],
  ];
  let kept = 0;
  for (const [role, b64, caption, w, h] of parts) {
    if (!b64) continue;
    const bytes = decodeBase64(b64);
    const path = `shot/${noteId}/${stem}--${role}.jpg`;
    const { error } = await storage.upload(path, bytes, { contentType: "image/jpeg", upsert: true });
    if (error) continue;
    const size = pictureSize(bytes);
    await sql`insert into hopper.attachments (note_id, original_file, storage_path, mime, width, height, caption,
                image_role, source_page_url, captured_on, content_sha256)
              values (${noteId}, ${`capture:${pageUrl}#${role}`}, ${path}, 'image/jpeg', ${size?.width ?? w}, ${size?.height ?? h}, ${caption},
                ${role}, ${pageUrl}, current_date, ${await bytesHash(bytes)})
              on conflict (note_id, original_file) do update set storage_path = excluded.storage_path, width = excluded.width,
                height = excluded.height, caption = excluded.caption, captured_on = excluded.captured_on, design_read = null,
                content_sha256 = excluded.content_sha256`;
    kept++;
  }
  // Motion strips (three frames a second apart, side by side), only for parts of the page that move. A desktop retake
  // replaces the page's strips: one that no longer moves is dropped with its file.
  if (shot.first) {
    const keep: string[] = [];
    for (const [i, m] of (shot.motion ?? []).slice(0, 2).entries()) {
      const bytes = decodeBase64(m.image);
      const path = `shot/${noteId}/${stem}--motion-${i + 1}.jpg`;
      const { error } = await storage.upload(path, bytes, { contentType: "image/jpeg", upsert: true });
      if (error) continue;
      const size = pictureSize(bytes);
      const original = `capture:${pageUrl}#motion-strip-${i + 1}`;
      const caption = `three frames of the ${m.where}, a second apart, left to right (${m.changed_pct}% of the view changes)`;
      await sql`insert into hopper.attachments (note_id, original_file, storage_path, mime, width, height, caption,
                  image_role, source_page_url, position_from_top_px_at_1440, captured_on, content_sha256)
                values (${noteId}, ${original}, ${path}, 'image/jpeg', ${size?.width ?? null}, ${size?.height ?? null}, ${caption},
                  'motion-strip', ${pageUrl}, ${m.top}, current_date, ${await bytesHash(bytes)})
                on conflict (note_id, original_file) do update set storage_path = excluded.storage_path, width = excluded.width,
                  height = excluded.height, caption = excluded.caption, position_from_top_px_at_1440 = excluded.position_from_top_px_at_1440,
                  captured_on = excluded.captured_on, content_sha256 = excluded.content_sha256`;
      keep.push(original);
      kept++;
    }
    const gone = await sql`delete from hopper.attachments where note_id = ${noteId} and source_page_url = ${pageUrl}
                             and image_role = 'motion-strip' and not (original_file = any(${keep}::text[])) returning storage_path`;
    const paths = gone.map((g: any) => g.storage_path).filter(Boolean);
    if (paths.length) await storage.remove(paths);
  }
  const figures = await keepFigures(noteId, shot, pageUrl, stem);
  if (kept) {
    // A phone-only retake knows nothing of the page's height at 1440, so it leaves the recorded height alone.
    await sql`insert into hopper.note_links (note_id, url, page_title, page_height_px_at_1440, videos_on_page, captured_on)
              values (${noteId}, ${pageUrl}, ${shot.title ?? null}, ${shot.full ? shot.full_height ?? null : null},
                ${shot.first ? shot.videos ?? null : null}, current_date)
              on conflict (note_id, url) do update set captured_on = excluded.captured_on,
                page_height_px_at_1440 = coalesce(excluded.page_height_px_at_1440, hopper.note_links.page_height_px_at_1440),
                videos_on_page = coalesce(excluded.videos_on_page, hopper.note_links.videos_on_page),
                page_title = coalesce(hopper.note_links.page_title, excluded.page_title)`;
  }
  return kept + figures;
}

// The page's largest figures (from the shot service: up to six, in page order), each kept with where it sat on the
// page: rendered size and distance from the top at the capture width, alt text and the caption beside it.
// A figure already on the note (same address) keeps its stored copy and design read and only gains the context.
async function keepFigures(noteId: string, shot: Shot, pageUrl: string, stem: string) {
  const figs = (shot.figures ?? []).filter((f) => /^https?:\/\//i.test(f.src)).slice(0, 6);
  // Fetched side by side, stored one at a time, so two addresses for the same picture can't both slip in.
  const fetched = await Promise.all(figs.map(async (f) => {
    const [known] = await sql`select 1 from hopper.attachments where note_id = ${noteId} and original_file = ${f.src}`;
    return known ? null : await fetchPicture(f.src, pageUrl);
  }));
  const results: number[] = [];
  for (const [i, f] of figs.entries()) results.push(await (async () => {
    const ctx = { caption: `Figure ${i + 1} of the page${f.alt ? `: ${f.alt}` : ""}`.slice(0, 400), onPage: f.caption?.trim() || null };
    // The image already on the note (same address, or the same bytes saved earlier with no role) gains the figure's
    // context; a figure whose bytes match another figure is not kept again.
    const annotate = async (where: any) => (await sql`update hopper.attachments set image_role = 'figure', source_page_url = ${pageUrl},
        caption = coalesce(caption, ${ctx.caption}), caption_on_page = ${ctx.onPage}, rendered_width_at_1440 = ${f.width},
        rendered_height_at_1440 = ${f.height}, position_from_top_px_at_1440 = ${f.top}, captured_on = current_date
      where note_id = ${noteId} and ${where} returning id`).length;
    if (await annotate(sql`original_file = ${f.src}`)) return 1;
    const p = fetched[i];
    if (!p) return 0;
    const hash = await bytesHash(p.bytes);
    const same = await sameOnNote(noteId, hash);
    if (same) return same.image_role == null ? await annotate(sql`id = ${same.id}`) : 0;
    const path = `shot/${noteId}/${stem}--figure-${String(i + 1).padStart(2, "0")}.${IMAGE_TYPES[p.mime]}`;
    const { error } = await storage.upload(path, p.bytes, { contentType: p.mime, upsert: true });
    if (error) return 0;
    const size = pictureSize(p.bytes);
    const rows = await sql`insert into hopper.attachments (note_id, original_file, storage_path, mime, width, height, caption,
                image_role, source_page_url, caption_on_page, rendered_width_at_1440, rendered_height_at_1440,
                position_from_top_px_at_1440, captured_on, content_sha256)
              values (${noteId}, ${f.src}, ${path}, ${p.mime}, ${size?.width ?? null}, ${size?.height ?? null}, ${ctx.caption},
                'figure', ${pageUrl}, ${ctx.onPage}, ${f.width}, ${f.height}, ${f.top}, current_date, ${hash})
              on conflict (note_id, original_file) do nothing returning id`;
    return rows.length;
  })());
  return results.reduce((a, b) => a + b, 0);
}

// Embed an app-captured note with the same recipe as hopper-embed (title, why saved, link, body),
// then file it into projects by closeness to their anchor notes. Locked and binned notes are never embedded or filed.
async function embedAndFile(id: string, refile: boolean) {
  const [n] = await sql`
    select n.id, n.title, n.body, n.why_saved, n.is_locked, n.deleted_at,
      (select coalesce(l.page_title, l.url) from hopper.note_links l where l.note_id = n.id limit 1) as link,
      (select l.page_text from hopper.note_links l where l.note_id = n.id and l.page_text is not null limit 1) as link_text,
      (select string_agg(l.transcript_summary, ' | ') from hopper.note_links l where l.note_id = n.id and l.transcript_summary is not null) as video
    from hopper.notes n where n.id = ${id}`;
  if (!n || n.is_locked || n.deleted_at) return [];
  const text = [n.title, n.why_saved, n.link ? `Link: ${n.link}` : null, n.link_text ? String(n.link_text).slice(0, 800) : null,
    n.video ? `Video: ${String(n.video).slice(0, 600)}` : null, n.body ? String(n.body).slice(0, 1200) : null]
    .filter(Boolean).join("\n").slice(0, 1800);
  if (!text.trim()) return [];
  const vec = await embed(text);
  await sql`insert into hopper.note_embeddings (note_id, embedding, model) values (${id}, ${vec}::extensions.vector, 'gte-small')
            on conflict (note_id) do update set embedding = excluded.embedding, created_at = now()`;
  if (!refile) return [];
  return await sql`select project, band from hopper.file_note(${id})`;
}

// HOP-43: a coarse device name from a user agent. iPads ask for desktop pages and say "Macintosh", so the app
// also says whether the screen takes touch.
function deviceFrom(ua: string, touch: boolean): string | null {
  if (!ua) return null;
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touch)) return "iPad";
  if (/iPhone|iPod/.test(ua)) return "iPhone";
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? "Android phone" : "Android tablet";
  if (/Macintosh|Mac OS X/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  if (/CrOS/.test(ua)) return "Chromebook";
  if (/Linux/.test(ua)) return "Linux";
  return "other";
}

// Who can unlock a note in the app: Keith's own locks, and safety-check locks on notes he captured
// himself (in the app, or clipped to Notion before Hopper existed), or asked Claude to save for him.
const OWN_CAPTURES = ["app", "notion-clip", "assistant"];
const canUnlock = (n: any) => n.lock_source === "user" || (OWN_CAPTURES.includes(n.source) && ["classifier", "pattern"].includes(n.lock_source));

// Card fields for lists. Locked notes are reduced to title, date and the lock.
// Binned notes also carry deleted_at and erases_at (the earliest time the nightly job erases them).
async function cards(rows: any[]) {
  const urls = await signed(rows.filter((r) => !r.is_locked).map((r) => r.image_path));
  const media = await mediaKinds(rows.filter((r) => !r.is_locked).map((r) => r.id));
  return rows.map((r) => {
    const bin = r.deleted_at ? { deleted_at: r.deleted_at, erases_at: erasesAt(r.deleted_at) } : {};
    return r.is_locked
      ? { id: r.id, locked: true, title: r.title ?? null, created_at: r.created_at, user_locked: r.lock_source === "user", ...bin }
      : {
        id: r.id, locked: false, title: r.title, excerpt: r.excerpt, format: r.format, created_at: r.created_at,
        image: r.image_path ? urls[r.image_path] ?? null : (r.link_thumb ?? null),
        host: r.link_url ? String(r.link_url).replace(/^https?:\/\/(www\.)?/, "").split("/")[0] : null,
        projects: r.projects ?? [], score: r.score ?? undefined, pinned: !!r.pinned, color: r.keep_color ?? null,
        media: media.get(r.id) ?? null, ...bin,
      };
  });
}

// What each card's thumbnail holds, for the small icon in its corner (HOP-44), by priority: a video, audio or PDF link,
// then a set of two or more pictures (with the count), then any other link. Page screenshots don't count as pictures.
async function mediaKinds(ids: string[]) {
  const out = new Map<string, { kind: string; count?: number }>();
  if (!ids.length) return out;
  const rows = await sql`
    select n.id,
      (select count(*)::int from hopper.attachments a where a.note_id = n.id and a.storage_path is not null
         and (a.image_role is null or a.image_role = 'figure')) as images,
      (select l.kind from hopper.note_links l where l.note_id = n.id
         order by case l.kind when 'video' then 0 when 'audio' then 1 when 'pdf' then 2 else 3 end limit 1) as link_kind
    from unnest(${sql.array(ids)}::uuid[]) as n(id)`;
  for (const r of rows) {
    const k = ["video", "audio", "pdf"].includes(r.link_kind) ? { kind: r.link_kind }
      : r.images > 1 ? { kind: "set", count: r.images }
      : r.link_kind ? { kind: "link" } : null;
    if (k) out.set(r.id, k);
  }
  return out;
}

// Each palette colour with the share of the image it covers, from the measurement stored with the read.
function withShares(d: any) {
  const share = new Map((d.measured?.palette ?? []).map((m: any) => [String(m.hex).toLowerCase(), m.share]));
  return (d.palette ?? []).map((p: any) => ({ ...p, share: p.share ?? share.get(String(p.hex).toLowerCase()) ?? null }));
}

// The page read (hopper-design, on the page's link) as the note page shows it. Older hand-written layout reads have no v.
function pageReadFor(r: any) {
  if (!r?.v) return null;
  return {
    summary: r.summary, first_screen: r.first_screen, phone: r.phone, structure: r.structure, width_use: r.width_use,
    image_treatment: r.image_treatment, type_and_colour: r.type_and_colour, palette: r.palette ?? [], moves: r.moves ?? [],
    move_notes: r.move_notes || null, motion: r.motion || null, strengths: r.strengths ?? [], gaps: r.gaps ?? [],
    borrow: r.how_to_borrow || null, read_at: r.read_at,
  };
}

// The design read (from hopper-design) as the note page shows it: only for images judged design references.
// A figure's light read has only a summary, moves and annotations.
function designFor(d: any) {
  if (!d?.is_reference) return null;
  if (d.light) return { light: true, kind: d.kind, summary: d.summary, moves: d.moves ?? [], annotations: d.annotations || null };
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
        // Pinned projects first, in the order they were pinned (HOP-13); then by most recent note.
        const rows = await sql`
          select p.id, p.name, count(n.id)::int as notes, max(n.created_at) as last_activity, p.pinned_at is not null as pinned
          from hopper.projects p join hopper.note_projects np on np.project_id = p.id
          join hopper.notes n on n.id = np.note_id and not n.archived and n.deleted_at is null
          group by p.id, p.name, p.pinned_at order by p.pinned_at nulls last, max(n.created_at) desc`;
        return json({ projects: rows });
      }
      case "pin_project": {
        // Pin or unpin a project pill. Pinning again keeps the original place in the pinned order.
        const [p] = await sql`update hopper.projects set pinned_at = case when ${Boolean(b.pinned)}::boolean then coalesce(pinned_at, now()) else null end
                              where id = ${b.project_id}::uuid returning id, pinned_at is not null as pinned`;
        if (!p) return json({ error: "not found" }, 404);
        return json({ ok: true, pinned: p.pinned });
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
        // HOP-34, as in hopper-mcp's search_notes: whole-word keyword hits weighted by field and added to the semantic
        // score; semantic-only hits under SEM_FLOOR left out.
        const word = wordPattern(q);
        const rows = await sql`
          with sem as (
            select e.note_id from hopper.note_embeddings e order by e.embedding <=> ${vec}::extensions.vector limit 40),
          kw as (
            select n.id as note_id,
              case when n.title ~* ${word} then ${KW.title}::float8
                   when exists (select 1 from hopper.note_works nw join hopper.works w on w.id = nw.work_id where nw.note_id = n.id and w.title ~* ${word})
                     or exists (select 1 from hopper.note_people np join hopper.people p on p.id = np.person_id where np.note_id = n.id and p.name ~* ${word})
                     then ${KW.tag}::float8
                   when n.summary ~* ${word} then ${KW.summary}::float8
                   else ${KW.body}::float8 end as bonus
            from hopper.notes n
            where not n.is_locked and n.deleted_at is null
              and (n.title ~* ${word} or n.summary ~* ${word} or n.body ~* ${word}
                   or exists (select 1 from hopper.note_works nw join hopper.works w on w.id = nw.work_id where nw.note_id = n.id and w.title ~* ${word})
                   or exists (select 1 from hopper.note_people np join hopper.people p on p.id = np.person_id where np.note_id = n.id and p.name ~* ${word}))
            order by bonus desc limit 30),
          cand as (select note_id from sem union select note_id from kw),
          hits as (
            select c.note_id, coalesce(1 - (e.embedding <=> ${vec}::extensions.vector), 0) + coalesce(k.bonus, 0) as score,
                   coalesce(1 - (e.embedding <=> ${vec}::extensions.vector), 0) as sem, k.bonus
            from cand c left join hopper.note_embeddings e on e.note_id = c.note_id left join kw k on k.note_id = c.note_id)
          select n.*, h.score from hits h join hopper.note_cards n on n.id = h.note_id
          where not n.is_locked and n.deleted_at is null and (h.bonus is not null or h.sem >= ${SEM_FLOOR})
          order by h.score desc limit 40`;
        // HOP-63: Keith searched in the app. Only the query's length is kept, never its words.
        const device = b.device === "phone" || b.device === "desktop" ? b.device : null;
        await sql`insert into hopper.ui_events (event, actor, device, query_len, result_ids)
                  values ('search', 'keith', ${device}, ${q.length}, ${sql.array(rows.map((r: any) => r.id))}::uuid[])`.catch(() => {});
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
        const links = await sql`select url, page_title, page_text, thumbnail_url, captured_on, page_height_px_at_1440, videos_on_page, layout_read,
                                  kind, transcript_summary, (transcript is not null) as has_transcript, fetch_status
                                from hopper.note_links where note_id = ${n.id} order by (layout_read is null), url`;
        const atts = await sql`select storage_path, caption, design_read, image_role, source_page_url, position_from_top_px_at_1440,
                                 rendered_width_at_1440, caption_on_page
                               from hopper.attachments where note_id = ${n.id}
                               order by source_page_url nulls first, position_from_top_px_at_1440 nulls first, id`;
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
            tags,
            links: links.map(({ layout_read, ...l }: any) => ({ ...l, page_read: pageReadFor(layout_read) })),
            // Each image says where it came from: a page's screenshot (first screens, whole page) or figure, or neither.
            images: atts.map((a: any) => ({ url: urls[a.storage_path] ?? null, caption: a.caption, design: designFor(a.design_read),
              role: a.image_role ?? null, page: a.source_page_url ?? null, top: a.position_from_top_px_at_1440 ?? null,
              width_at_1440: a.rendered_width_at_1440 ?? null, caption_on_page: a.caption_on_page ?? null })),
          },
          related: await cards(related),
        });
      }
      case "update": {
        // Title, body, why-saved line, format, colour, pin and archive. Locked and binned notes can't be edited here.
        // why_saved is how a share gets its note after it has been saved (shares save on arrival; the note is optional).
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
            why_saved = case when ${has("why_saved")}::boolean then nullif(trim(${b.why_saved ?? ""}::text), '') else why_saved end,
            format = case when ${has("format")}::boolean then ${b.format ?? null}::text else format end,
            keep_color = case when ${has("color")}::boolean then ${b.color ?? null}::text else keep_color end,
            pinned = case when ${has("pinned")}::boolean then ${Boolean(b.pinned)}::boolean else pinned end,
            archived = case when ${has("archived")}::boolean then ${Boolean(b.archived)}::boolean else archived end,
            edited_at = now()
          where id = ${b.id}
          returning id, edited_at, format, keep_color, pinned, archived, why_saved`;
        if ((has("title") || has("body") || has("why_saved")) && OWN_CAPTURES.includes(n.source)) {
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
        const wantShot = Boolean(b.screenshot) && Boolean(url) && /^https?:\/\//i.test(url ?? "");
        // Only trusted server-side callers (hopper-mcp) may mark a note as saved by Claude; everything else is the app.
        const source = user.email === "service" && b.source === "assistant" ? "assistant" : "app";
        const lock = Boolean(b.lock);
        // HOP-43: how and on what the note was captured. Only the app's own routes are taken from a signed-in caller.
        const service = user.email === "service";
        const route = source === "assistant" ? "mcp"
          : service ? (b.route === "extension" ? "extension" : "app")
          : (["share", "new"].includes(b.route) ? b.route : "app");
        const device = source === "assistant" ? null
          : deviceFrom(service ? String(b.user_agent ?? "") : (req.headers.get("user-agent") ?? ""), Boolean(b.touch));
        // hopper-mcp only (HOP-60): projects named exactly, to file the note there instead of filing by closeness.
        const projectNames: string[] = user.email === "service" && Array.isArray(b.projects) ? b.projects.map(String).slice(0, 10) : [];
        const chosen = projectNames.length ? await sql`select id, name from hopper.projects where name = any(${projectNames}::text[])` : [];
        if (chosen.length < new Set(projectNames).size) return json({ error: "unknown project" }, 400);
        const [n] = await sql`
          insert into hopper.notes (source, title, body, why_saved, is_locked, lock_source, lock_reason, format, capture_route, capture_device)
          values (${source}, ${title}, ${text}, ${why}, ${lock}, ${lock ? "user" : null}, ${lock ? "Locked at capture" : null},
                  ${(images.length || imageUrls.length) && !url && !text ? "image" : null}, ${route}, ${device})
          returning id, created_at`;
        // Screenshots first, so the first screen is the note's picture on the board.
        let shotResult: any = null;
        if (wantShot) {
          const shot = await takeShot(url!);
          shotResult = "error" in shot ? shot : { kept: await keepShots(n.id, shot, url!), clipped: shot.clipped, full_height: shot.full_height };
          if (!("error" in shot) && !lock) background(measurePage(n.id, url!));
        }
        if (url) await sql`insert into hopper.note_links (note_id, url, page_title) values (${n.id}, ${url}, ${title}) on conflict (note_id, url) do nothing`;
        for (const [i, im] of images.entries()) {
          const path = `app/${n.id}/${i}.jpg`;
          const bytes = Uint8Array.from(atob(im.data), (c) => c.charCodeAt(0));
          const hash = await bytesHash(bytes);
          if (await sameOnNote(n.id, hash)) continue;
          const { error } = await storage.upload(path, bytes, { contentType: "image/jpeg", upsert: true });
          if (error) continue;
          await sql`insert into hopper.attachments (note_id, storage_path, mime, width, height, content_sha256)
                    values (${n.id}, ${path}, 'image/jpeg', ${Number(im.width) || null}, ${Number(im.height) || null}, ${hash})`;
        }
        let fetched = 0;
        for (const [i, src] of imageUrls.entries()) {
          const p = await fetchPicture(src, url ?? undefined);
          if (!p) continue;
          const path = `link/${n.id}/${images.length + i}.${IMAGE_TYPES[p.mime]}`;
          const hash = await bytesHash(p.bytes);
          if (await sameOnNote(n.id, hash)) continue;
          const { error } = await storage.upload(path, p.bytes, { contentType: p.mime, upsert: true });
          if (error) continue;
          const size = pictureSize(p.bytes);
          const rows = await sql`insert into hopper.attachments (note_id, original_file, storage_path, mime, width, height, content_sha256)
                    values (${n.id}, ${p.source}, ${path}, ${p.mime}, ${size?.width ?? null}, ${size?.height ?? null}, ${hash})
                    on conflict (note_id, original_file) do nothing returning id`;
          fetched += rows.length;
        }
        try {
          const read = await linkify(n.id, source === "assistant");
          // HOP-50: a page that refused the fetch gets a real browser, after the reply (a screenshot capture already has one).
          if (read && !read.ok && !wantShot && !lock) background(rescue(n.id, read.linkId, read.url));
        } catch (_) { /* the note is saved either way */ }
        // HOP-61: the extension reads a video's transcript off the page; keep it on the link and summarise it in the background.
        const transcript = url && typeof b.transcript === "string" ? b.transcript.trim().slice(0, TRANSCRIPT_MAX) : "";
        let transcriptKept = false;
        if (transcript.length >= 200) {
          const rows = await sql`update hopper.note_links set transcript = ${transcript},
                                   transcript_language = ${String(b.transcript_language ?? "").slice(0, 20) || null},
                                   transcript_source = ${service && route === "extension" ? "extension" : "assistant"},
                                   transcript_at = now(), transcript_summary = null
                                 where note_id = ${n.id} and url = ${url} returning id`;
          transcriptKept = rows.length > 0;
          if (transcriptKept && !lock) {
            try { await sql`select hopper.call_fn('hopper-transcript', ${sql.json({ link_ids: [rows[0].id] })})`; } catch (_) { /* a sweep picks it up */ }
          }
        }
        let filed: any[] = [];
        if (chosen.length && !lock) {
          for (const p of chosen) {
            await sql`insert into hopper.note_projects (note_id, project_id, confidence, confirmed, added_by)
                      values (${n.id}, ${p.id}, 'high', true, 'assistant') on conflict do nothing`;
          }
          filed = chosen.map((p: any) => ({ project: p.name, band: "chosen" }));
          try { await embedAndFile(n.id, false); } catch (_) { /* search catches up on the next edit */ }
        } else {
          try { filed = await embedAndFile(n.id, true); } catch (_) { /* filing is best-effort; the note is saved either way */ }
        }
        // Claude tagging runs in the background once filing is done (HOP-5); it does nothing while auto_tag is off.
        try { await sql`select hopper.tag_new(${n.id}::uuid)`; } catch (_) { /* the sweep picks it up */ }
        const [{ c: stored }] = await sql`select count(*)::int as c from hopper.attachments where note_id = ${n.id}`;
        const [{ t }] = await sql`select title as t from hopper.notes where id = ${n.id}`;
        return json({ saved: { ...n, title: t }, filed, images: stored, image_urls_kept: fetched, screenshot: shotResult,
                      transcript: transcriptKept || undefined });
      }
      case "screenshot": {
        // Add (or retake) page screenshots on an existing note: its own link, or { url } for another page of the same
        // site (a case study, an about page), which is added to the note as a link. Locked and binned notes are left alone.
        const [n] = await sql`select id, is_locked, deleted_at from hopper.notes where id = ${b.id}`;
        if (!n || n.is_locked) return json({ error: "not available" }, 404);
        if (n.deleted_at) return IN_BIN();
        const [link] = await sql`select url from hopper.note_links where note_id = ${n.id} order by url limit 1`;
        const url = String(b.url ?? link?.url ?? "");
        if (!/^https?:\/\//i.test(url)) return json({ error: "this note has no web address" }, 400);
        // { views: ["first-screen-390"] } takes only some views, e.g. adding phone screens without redoing the desktop ones.
        const roles = Array.isArray(b.views) ? ROLES.filter((r) => b.views.includes(r)) : ROLES;
        if (!roles.length) return json({ error: `views must be some of ${ROLES.join(", ")}` }, 400);
        const shot = await takeShot(url, roles);
        if ("error" in shot) return json(shot, 502);
        const kept = await keepShots(n.id, shot, url);
        // A desktop retake measures the page again, after the reply (HOP-55, 56, 57).
        if (roles.includes("first-screen-1440")) background(measurePage(n.id, url));
        return json({ ok: true, kept, clipped: shot.clipped, full_height: shot.full_height });
      }
      case "prune_shots": {
        // Server-side only: remove screenshot files that no attachment points at any more (left by retakes under the
        // older file names). Only touches shot/ in the images bucket.
        if (user.email !== "service") return json({ error: "not available" }, 403);
        const rows = await sql`select o.name from storage.objects o where o.bucket_id = 'hopper-images' and o.name like 'shot/%'
                                 and not exists (select 1 from hopper.attachments a where a.storage_path = o.name) limit 500`;
        const names = rows.map((r: any) => r.name);
        if (names.length) { const { error } = await storage.remove(names); if (error) return json({ error: error.message }, 500); }
        return json({ ok: true, removed: names });
      }
      case "hash_images": {
        // Server-side only: fill content_sha256 for images stored before hashing, up to 25 a call, and report what is
        // left. Reads files; changes nothing but the hash column.
        if (user.email !== "service") return json({ error: "not available" }, 403);
        const rows = await sql`select id, storage_path from hopper.attachments where storage_path is not null and content_sha256 is null
                               order by id limit 25`;
        let hashed = 0;
        const failed: string[] = [];
        for (const r of rows as any[]) {
          const { data, error } = await storage.download(r.storage_path);
          if (error || !data) { failed.push(r.id); continue; }
          await sql`update hopper.attachments set content_sha256 = ${await bytesHash(new Uint8Array(await data.arrayBuffer()))} where id = ${r.id}`;
          hashed++;
        }
        const [{ left }] = await sql`select count(*)::int as left from hopper.attachments where storage_path is not null and content_sha256 is null`;
        return json({ ok: true, hashed, failed, left });
      }
      case "measure": {
        // HOP-55, 56, 57: measure a captured page's motion and type again, without retaking its screenshots.
        // { id, url? } (the note's first captured page by default). Waits for the readings and says what was stored.
        const [n] = await sql`select id, is_locked, deleted_at from hopper.notes where id = ${b.id}`;
        if (!n || n.is_locked) return json({ error: "not available" }, 404);
        if (n.deleted_at) return IN_BIN();
        const [link] = b.url
          ? await sql`select url from hopper.note_links where note_id = ${n.id} and url = ${String(b.url)}`
          : await sql`select url from hopper.note_links where note_id = ${n.id} order by captured_on is null, url limit 1`;
        if (!link || !/^https?:\/\//i.test(link.url)) return json({ error: "this note has no captured page at that address" }, 400);
        return json({ ok: true, url: link.url, ...(await measurePage(n.id, link.url)) });
      }
      case "refetch": {
        // HOP-50 Retry: read the note's page again, plainly and then in a real browser. Says whether it worked.
        const [n] = await sql`select id, is_locked, deleted_at from hopper.notes where id = ${b.id}`;
        if (!n || n.is_locked) return json({ error: "not available" }, 404);
        if (n.deleted_at) return IN_BIN();
        const read = await linkify(n.id);
        if (!read) return json({ error: "this note has no web address" }, 400);
        const ok = read.ok || await rescue(n.id, read.linkId, read.url);
        if (read.ok) { try { await embedAndFile(n.id, false); } catch (_) { /* search catches up on the next edit */ } }
        return json({ ok });
      }
      case "add_images": {
        // HOP-50 Add screenshot: pictures added to a saved note (shrunk to JPEG by the app), four per note at most,
        // not counting page screenshots. The tagger and the design read look again.
        const [n] = await sql`select id, is_locked, deleted_at from hopper.notes where id = ${b.id}`;
        if (!n || n.is_locked) return json({ error: "not available" }, 404);
        if (n.deleted_at) return IN_BIN();
        const [{ c }] = await sql`select count(*)::int as c from hopper.attachments where note_id = ${n.id} and image_role is null`;
        const images = (Array.isArray(b.images) ? b.images : []).slice(0, Math.max(0, 4 - c))
          .filter((im: any) => typeof im?.data === "string" && im.data.length < 4_000_000);
        if (!images.length) return json({ error: c >= 4 ? "this note already has four images" : "no image" }, 400);
        let added = 0;
        for (const im of images) {
          const bytes = Uint8Array.from(atob(im.data), (ch) => ch.charCodeAt(0));
          const hash = await bytesHash(bytes);
          if (await sameOnNote(n.id, hash)) continue;
          const path = `app/${n.id}/${hash.slice(0, 12)}.jpg`;
          const { error } = await storage.upload(path, bytes, { contentType: "image/jpeg", upsert: true });
          if (error) continue;
          await sql`insert into hopper.attachments (note_id, storage_path, mime, width, height, content_sha256)
                    values (${n.id}, ${path}, 'image/jpeg', ${Number(im.width) || null}, ${Number(im.height) || null}, ${hash})`;
          added++;
        }
        if (added) await sql`update hopper.notes set tagged_at = null where id = ${n.id} and not is_locked`;
        return json({ ok: true, added });
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
        // Silent navigation count (hopper.ui_events), for deciding where the project pills live, and (HOP-63)
        // which notes Keith opens. Searches are logged by the search action itself.
        const EVENTS = ["open", "pill", "sheet", "sheet_pick", "topic", "note_open"];
        if (!EVENTS.includes(b.event)) return json({ error: "bad event" }, 400);
        const device = b.device === "phone" || b.device === "desktop" ? b.device : null;
        const topic = typeof b.topic === "string" ? b.topic.slice(0, 80) : null;
        const noteId = typeof b.note_id === "string" && /^[0-9a-f-]{36}$/i.test(b.note_id) ? b.note_id : null;
        await sql`insert into hopper.ui_events (event, actor, project_id, topic, device, note_id)
                  values (${b.event}, 'keith', ${b.project_id ?? null}::uuid, ${topic}, ${device}, ${noteId}::uuid)`;
        return json({ ok: true });
      }
      default:
        return json({ error: "unknown action" }, 400);
    }
  } catch (e) {
    return json({ error: String(e).slice(0, 300) }, 500);
  }
});
