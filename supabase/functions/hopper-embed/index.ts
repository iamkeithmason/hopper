import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import postgres from "npm:postgres@3.4.4";

// Hopper embeddings with Supabase's built-in gte-small model (384 dimensions). Free; no API key.
// Embeds UNLOCKED notes that have no embedding yet. Locked notes never get a row.
// Body: { limit?: number (default 4, max 8), ids?: uuid[], refresh?: bool }. Guarded by the hashed invoke token.
// refresh (with ids) re-embeds notes that already have an embedding, e.g. after hopper-design adds a design read.

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2 });
// @ts-ignore Supabase global is provided by the edge runtime
const session = new Supabase.ai.Session("gte-small");

async function sha256(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// What the note is about, in a form that suits a small model with a 512-token window:
// the AI facets first (they are dense), then the start of the note itself.
function embedText(n: any) {
  const parts = [
    n.title,
    n.summary,
    n.aesthetics?.length ? `Aesthetics: ${n.aesthetics.join(", ")}` : null,
    n.design ? `Design: ${String(n.design).slice(0, 600)}` : null,
    n.topics?.length ? `Topics: ${n.topics.join(", ")}` : null,
    n.people?.length ? `People: ${n.people.join(", ")}` : null,
    n.works?.length ? `Works: ${n.works.join(", ")}` : null,
    n.link_title ? `Link: ${n.link_title}` : null,
    n.body ? String(n.body).slice(0, 1200) : null,
    n.list_text ? String(n.list_text).slice(0, 600) : null,
  ];
  return parts.filter(Boolean).join("\n").slice(0, 1800);
}

Deno.serve(async (req: Request) => {
  try {
    const token = req.headers.get("x-hopper-token") ?? "";
    const [{ value: want }] = await sql`select value from hopper.settings where key = 'invoke_token_sha256'`;
    if ((await sha256(token)) !== want) return new Response("forbidden", { status: 403 });

    const body = await req.json().catch(() => ({}));
    // The model is CPU-heavy: keep calls small (about 4 notes). Parallel callers pass their own ids.
    const limit = Math.min(Number(body.limit ?? 4), 8);
    const ids = Array.isArray(body.ids) ? body.ids : null;
    const refresh = body.refresh === true && ids !== null;
    const notes = await sql`
      select n.id, n.title, n.summary, n.body, n.aesthetics,
        (select string_agg(concat_ws('. ', a.design_read->>'summary', a.design_read->>'kind',
                  array_to_string(array(select jsonb_array_elements_text(a.design_read->'good_reference_for')), ', ')), ' | ')
           from hopper.attachments a where a.note_id = n.id and (a.design_read->>'is_reference')::boolean) as design,
        (select string_agg(i->>'text', '; ') from jsonb_array_elements(case when jsonb_typeof(n.list_items) = 'array' then n.list_items else '[]'::jsonb end) i) as list_text,
        (select array_agg(t.name) from hopper.note_topics nt join hopper.topics t on t.id = nt.topic_id where nt.note_id = n.id) as topics,
        (select array_agg(p.name) from hopper.note_people np join hopper.people p on p.id = np.person_id where np.note_id = n.id) as people,
        (select array_agg(w.title) from hopper.note_works nw join hopper.works w on w.id = nw.work_id where nw.note_id = n.id) as works,
        (select l.page_title from hopper.note_links l where l.note_id = n.id and l.page_title is not null limit 1) as link_title
      from hopper.notes n
      where n.is_locked = false and n.tagged_at is not null
        and (${refresh}::boolean or not exists (select 1 from hopper.note_embeddings e where e.note_id = n.id))
        and (${ids}::uuid[] is null or n.id = any(${ids}::uuid[]))
      order by n.created_at limit ${limit}`;

    let done = 0;
    for (const n of notes as any[]) {
      const text = embedText(n);
      if (!text.trim()) continue;
      const emb = await session.run(text, { mean_pool: true, normalize: true });
      const vec = `[${Array.from(emb as number[]).join(",")}]`;
      // Re-check the lock at write time, so a note locked meanwhile never gets a row.
      const r = await sql`insert into hopper.note_embeddings (note_id, embedding, model)
                          select ${n.id}, ${vec}::extensions.vector, 'gte-small'
                          where exists (select 1 from hopper.notes where id = ${n.id} and is_locked = false)
                          on conflict (note_id) do update set embedding = excluded.embedding, created_at = now()
                            where ${refresh}::boolean returning 1`;
      done += r.length;
    }
    const [{ left }] = await sql`select count(*)::int as left from hopper.notes n
      where n.is_locked = false and n.tagged_at is not null
        and not exists (select 1 from hopper.note_embeddings e where e.note_id = n.id)`;
    return new Response(JSON.stringify({ embedded: done, left }), { headers: { "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e).slice(0, 300) }), { status: 500, headers: { "content-type": "application/json" } });
  }
});
