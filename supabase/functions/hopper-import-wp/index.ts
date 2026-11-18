import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import postgres from "npm:postgres@3.4.4";

// Imports Keith's own WordPress blog posts into Hopper as notes, filed (confirmed) under one project.
// Body: { site: "ontheruinofbritain.wordpress.com", project: "Essays", dry_run?: boolean }
// Idempotent: a post whose URL is already in hopper.note_links is skipped.
// Guarded by the hashed invoke token, like the other Hopper functions.

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2 });

async function sha256(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&#039;": "'", "&apos;": "'",
  "&nbsp;": " ", "&#8217;": "’", "&#8216;": "‘", "&#8220;": "“", "&#8221;": "”",
  "&#8211;": "–", "&#8212;": "—", "&#8230;": "…", "&hellip;": "…",
  "&rsquo;": "’", "&lsquo;": "‘", "&rdquo;": "”", "&ldquo;": "“", "&ndash;": "–", "&mdash;": "—",
};
function decode(s: string) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&[a-z]+;|&#\d+;/gi, (m) => ENTITIES[m] ?? m);
}
function htmlToText(html: string) {
  return decode(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|h[1-6]|li|blockquote|tr)>/gi, "\n\n")
      .replace(/<li[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, ""),
  ).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

Deno.serve(async (req: Request) => {
  try {
    const token = req.headers.get("x-hopper-token") ?? "";
    const [{ value: want }] = await sql`select value from hopper.settings where key = 'invoke_token_sha256'`;
    if ((await sha256(token)) !== want) return new Response("forbidden", { status: 403 });

    const body = await req.json().catch(() => ({}));
    const site = String(body.site ?? "ontheruinofbritain.wordpress.com");
    const projectName = String(body.project ?? "Essays");
    const dry = Boolean(body.dry_run);

    const [proj] = await sql`select id from hopper.projects where name = ${projectName}`;
    if (!proj) return new Response(JSON.stringify({ error: `no project ${projectName}` }), { status: 400 });

    // Collect every post (100 per page).
    const posts: any[] = [];
    for (let page = 1; page <= 10; page++) {
      const url = `https://public-api.wordpress.com/rest/v1.1/sites/${site}/posts/?number=100&page=${page}&status=publish&fields=ID,title,URL,date,content`;
      const r = await fetch(url);
      if (!r.ok) return new Response(JSON.stringify({ error: `wp ${r.status} on page ${page}` }), { status: 502 });
      const j = await r.json();
      posts.push(...(j.posts ?? []));
      if (!j.posts?.length || posts.length >= (j.found ?? 0)) break;
    }

    let inserted = 0, skipped = 0;
    const sample: string[] = [];
    for (const p of posts) {
      const url = String(p.URL);
      const [exists] = await sql`select 1 from hopper.note_links where url = ${url} limit 1`;
      if (exists) { skipped++; continue; }
      const title = decode(String(p.title ?? "")).trim() || "(untitled post)";
      const text = htmlToText(String(p.content ?? ""));
      if (sample.length < 3) sample.push(`${p.date} ${title} (${text.length} chars)`);
      if (dry) { inserted++; continue; }
      await sql.begin(async (tx) => {
        const [n] = await tx`
          insert into hopper.notes (source, title, body, created_at, format, tagged_at, tagger_model, why_saved)
          values ('blog', ${title}, ${text}, ${p.date}, 'note', now(), 'import:blog', 'Published on On the Ruin of Britain')
          returning id`;
        await tx`insert into hopper.note_links (note_id, url, kind, provider, page_title, page_text, fetched_at, is_dead, fetch_status)
                 values (${n.id}, ${url}, 'article', 'wordpress', ${title}, ${text}, now(), false, 'ok')`;
        await tx`insert into hopper.note_projects (note_id, project_id, confidence, confirmed)
                 values (${n.id}, ${proj.id}, 'high', true) on conflict do nothing`;
      });
      inserted++;
    }
    return new Response(JSON.stringify({ found: posts.length, inserted, skipped, dry, sample }),
      { headers: { "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e).slice(0, 300) }), { status: 500, headers: { "content-type": "application/json" } });
  }
});
