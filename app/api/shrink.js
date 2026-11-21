// Image shrinking for Hopper's palette measurement. hopper-design measures colours by decoding an image's pixels,
// and above about 4 megapixels that runs past the edge function's compute limit, so those reads had no palette.
// This function scales such an image down (sharp, libvips) so hopper-design can measure the small copy instead.
// Colour shares survive the scaling: each measured share is a fraction of the image, not a pixel count.
//
// Auth: the x-shot-token header, the same token as /api/shot (sha256 in SHOT_TOKEN_SHA256).
// POST { url } where url is a signed Supabase Storage address for the image (it expires within minutes).
//   -> { png, width, height, source_width, source_height }   (png as base64, at most 400 px on its long side)
// Only Supabase Storage signed addresses are fetched, so this can't be used to reach anything else.
import { createHash } from "node:crypto";
import sharp from "sharp";

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const MAX_SIDE = 400;
const MAX_BYTES = 12_000_000;

function allowed(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && u.hostname.endsWith(".supabase.co") && u.pathname.startsWith("/storage/v1/object/sign/");
  } catch { return false; }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const want = process.env.SHOT_TOKEN_SHA256;
  const tok = req.headers["x-shot-token"];
  if (!want || typeof tok !== "string" || sha256(tok) !== want) return res.status(401).json({ error: "unauthorised" });
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body ?? {});
  const url = String(body.url ?? "");
  if (!allowed(url)) return res.status(400).json({ error: "give a signed Supabase Storage address" });
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return res.status(502).json({ error: `fetch ${r.status}` });
    const bytes = Buffer.from(await r.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_BYTES) return res.status(400).json({ error: "size" });
    const img = sharp(bytes, { limitInputPixels: 100_000_000 });
    const meta = await img.metadata();
    const { data, info } = await img
      .resize(MAX_SIDE, MAX_SIDE, { fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer({ resolveWithObject: true });
    return res.status(200).json({ png: data.toString("base64"), width: info.width, height: info.height,
      source_width: meta.width ?? null, source_height: meta.height ?? null });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message ?? e).slice(0, 200) });
  }
}
