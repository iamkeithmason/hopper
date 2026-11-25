import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import postgres from "npm:postgres@3.4.4";

// Hopper link fetcher. For links on UNLOCKED notes only: fetches the page,
// saves title and readable text, marks dead links. No AI involved.
// Body: { limit?: number (default 20, max 40) } or { link_ids: string[] }.
// Guarded by the same hashed invoke token as hopper-tag.

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 3 });

const PAGE_CAP = 4000; // characters of readable text kept per link
const MAX_BYTES = 1_500_000; // stop reading a response after this
const UA = "Mozilla/5.0 (compatible; HopperFetch/1.0; personal notes archive)";
const BROWSER_HEADERS = {
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "accept-language": "en-GB,en;q=0.9",
};
// Private workspaces and sign-in walls: never worth fetching.
const PRIVATE = /(^|\.)(docs\.google\.com|drive\.google\.com|mail\.google\.com|notion\.so|notion\.site|atlassian\.net|figma\.com|miro\.com|funretrospectives\.com|slack\.com|trello\.com|app\.[a-z0-9-]+\.[a-z]+)$/i;
const LOCAL = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/;

async function sha256(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

type Result = {
  status: string; // ok, dead, blocked, private, timeout, error, skipped
  http?: number;
  title?: string | null;
  text?: string | null;
  creator?: string | null;
  thumbnail?: string | null;
  dead: boolean;
};

function decodeEntities(s: string) {
  return s
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

function meta(html: string, name: string) {
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*>`, "i");
  const tag = html.match(re)?.[0];
  const c = tag?.match(/content=["']([^"']*)["']/i)?.[1];
  return c ? decodeEntities(c).trim() : null;
}

function readable(html: string) {
  const title = meta(html, "og:title") ?? decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim();
  const desc = meta(html, "og:description") ?? meta(html, "description");
  const main = html.match(/<(article|main)[\s\S]*?<\/\1>/i)?.[0] ?? html;
  const body = decodeEntities(
    main
      .replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|iframe)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|blockquote)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
  const text = [desc, body].filter(Boolean).join("\n").slice(0, PAGE_CAP);
  return { title: title || null, text: text || null };
}

async function readCapped(res: Response) {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    total += value.length;
  }
  reader.cancel().catch(() => {});
  const all = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  return new TextDecoder("utf-8", { fatal: false }).decode(all);
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, ms = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...init, redirect: "follow", signal: ctl.signal, headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,*/*;q=0.8", ...(init.headers ?? {}) } });
  } finally {
    clearTimeout(t);
  }
}

function youtubeId(u: URL) {
  if (u.hostname.endsWith("youtu.be")) return u.pathname.slice(1);
  if (u.hostname.includes("youtube.com")) return u.searchParams.get("v") ?? u.pathname.split("/").pop();
  return null;
}

async function fetchOne(link: { url: string; kind: string }): Promise<Result> {
  let u: URL;
  try {
    u = new URL(link.url.startsWith("http") ? link.url : `https://${link.url}`);
  } catch {
    return { status: "error", dead: false };
  }
  if (LOCAL.test(u.hostname)) return { status: "skipped", dead: false };
  if (PRIVATE.test(u.hostname)) return { status: "private", dead: false };

  try {
    // YouTube: oEmbed gives title, channel and thumbnail without scraping.
    if (youtubeId(u)) {
      const r = await fetchWithTimeout(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(u.href)}`);
      if (r.status === 404 || r.status === 401 || r.status === 403) return { status: "dead", http: r.status, dead: r.status === 404 };
      const j = await r.json();
      return { status: "ok", http: r.status, title: j.title ?? null, creator: j.author_name ?? null, thumbnail: j.thumbnail_url ?? null, dead: false };
    }

    let r = await fetchWithTimeout(u.href);
    // HOP-50: a page that refuses Hopper is asked once more as a browser would ask.
    if ([401, 403, 429, 451, 503, 999].includes(r.status)) {
      r.body?.cancel();
      r = await fetchWithTimeout(u.href, { headers: BROWSER_HEADERS });
    }
    if (r.status === 404 || r.status === 410) { r.body?.cancel(); return { status: "dead", http: r.status, dead: true }; }
    if ([401, 403, 429, 451, 999].includes(r.status)) { r.body?.cancel(); return { status: "blocked", http: r.status, dead: false }; }
    if (r.status >= 400) { r.body?.cancel(); return { status: "error", http: r.status, dead: false }; }

    const type = r.headers.get("content-type") ?? "";
    if (!type.includes("html")) {
      r.body?.cancel();
      // PDFs, images and audio: alive is all we learn here.
      return { status: "ok", http: r.status, dead: false };
    }
    const html = await readCapped(r);
    const { title, text } = readable(html);
    return { status: "ok", http: r.status, title, text, thumbnail: meta(html, "og:image"), dead: false };
  } catch (e) {
    const msg = String(e);
    if (msg.includes("AbortError") || msg.includes("aborted")) return { status: "timeout", dead: false };
    // DNS failure or refused connection: the site has gone.
    if (/dns|lookup|ENOTFOUND|failed to lookup|Name or service not known|connection refused/i.test(msg)) return { status: "dead", dead: true };
    return { status: "error", dead: false };
  }
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

Deno.serve(async (req: Request) => {
  try {
    const token = req.headers.get("x-hopper-token") ?? "";
    const [{ value: want }] = await sql`select value from hopper.settings where key = 'invoke_token_sha256'`;
    if ((await sha256(token)) !== want) return new Response("forbidden", { status: 403 });

    const body = await req.json().catch(() => ({}));
    const limit = Math.min(Number(body.limit ?? 20), 40);
    // Links on locked notes are never fetched.
    const links = Array.isArray(body.link_ids)
      ? await sql`select l.id, l.url, l.kind from hopper.note_links l join hopper.notes n on n.id = l.note_id
                  where l.id = any(${body.link_ids}) and n.is_locked = false`
      : await sql`select l.id, l.url, l.kind from hopper.note_links l join hopper.notes n on n.id = l.note_id
                  where l.fetched_at is null and n.is_locked = false order by l.id limit ${limit}`;

    const results = await pool(links as any[], 6, async (l) => ({ id: l.id, ...(await fetchOne(l)) }));

    for (const r of results) {
      await sql`update hopper.note_links set
          page_title = coalesce(page_title, ${r.title ?? null}),
          page_text = coalesce(${r.text ?? null}, page_text),
          creator = coalesce(creator, ${r.creator ?? null}),
          thumbnail_url = coalesce(thumbnail_url, ${r.thumbnail ?? null}),
          is_dead = ${r.dead},
          fetch_status = ${r.status},
          fetched_at = now()
        where id = ${r.id}`;
    }

    const counts: Record<string, number> = {};
    for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
    const [{ left }] = await sql`select count(*)::int as left from hopper.note_links l join hopper.notes n on n.id = l.note_id
                                 where l.fetched_at is null and n.is_locked = false`;
    return new Response(JSON.stringify({ fetched: results.length, counts, left }), { headers: { "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e).slice(0, 300) }), { status: 500, headers: { "content-type": "application/json" } });
  }
});
