// Measured palette for one image: real pixel colours, so hex values are never guessed by the model.
// Decode, shrink to about 160px on the long side, median-cut into up to 16 boxes,
// merge boxes that look alike (CIE76 distance under 10), and keep colours covering at least 1%.
import { decode } from "https://deno.land/x/imagescript@1.3.0/mod.ts";

export type Swatch = { hex: string; share: number };
export type Measured = { width: number; height: number; palette: Swatch[]; lightness: number };

type Px = [number, number, number];

const hex = ([r, g, b]: Px) => "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

function lab([r, g, b]: Px) {
  const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const R = lin(r), G = lin(g), B = lin(b);
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047);
  const y = f(R * 0.2126 + G * 0.7152 + B * 0.0722);
  const z = f((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function medianCut(px: Px[], boxes: number): Px[][] {
  const out: Px[][] = [px];
  while (out.length < boxes) {
    // Split the box with the widest channel range, weighted by how many pixels it holds.
    let best = -1, bestScore = 0, bestCh = 0;
    out.forEach((box, i) => {
      if (box.length < 2) return;
      for (let ch = 0; ch < 3; ch++) {
        let lo = 255, hi = 0;
        for (const p of box) { if (p[ch] < lo) lo = p[ch]; if (p[ch] > hi) hi = p[ch]; }
        const score = (hi - lo) * Math.sqrt(box.length);
        if (score > bestScore) { bestScore = score; best = i; bestCh = ch; }
      }
    });
    if (best < 0) break;
    const box = out[best].sort((a, b) => a[bestCh] - b[bestCh]);
    const mid = box.length >> 1;
    out.splice(best, 1, box.slice(0, mid), box.slice(mid));
  }
  return out;
}

export async function measure(bytes: Uint8Array): Promise<Measured> {
  const img: any = await decode(bytes);
  const width = img.width, height = img.height;
  const k = Math.min(1, 160 / Math.max(width, height));
  if (k < 1) img.resize(Math.max(1, Math.round(width * k)), Math.max(1, Math.round(height * k)));
  const bm: Uint8ClampedArray = img.bitmap;
  const px: Px[] = [];
  for (let i = 0; i < bm.length; i += 4) if (bm[i + 3] > 127) px.push([bm[i], bm[i + 1], bm[i + 2]]);
  const total = px.length || 1;

  let groups = medianCut(px, 16).filter((b) => b.length).map((b) => {
    const s = b.reduce((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0]);
    const c: Px = [s[0] / b.length, s[1] / b.length, s[2] / b.length];
    return { c, n: b.length, l: lab(c) };
  }).sort((a, b) => b.n - a.n);

  // Merge near-identical colours into the larger one, weighting the average by pixel count.
  const merged: typeof groups = [];
  for (const g of groups) {
    const into = merged.find((m) => dist(m.l, g.l) < 10);
    if (!into) { merged.push({ ...g }); continue; }
    const n = into.n + g.n;
    into.c = [0, 1, 2].map((i) => (into.c[i] * into.n + g.c[i] * g.n) / n) as Px;
    into.n = n;
    into.l = lab(into.c);
  }
  groups = merged.sort((a, b) => b.n - a.n);

  const lightness = Math.round(groups.reduce((a, g) => a + g.l[0] * g.n, 0) / total);
  const palette = groups.filter((g) => g.n / total >= 0.01).slice(0, 10)
    .map((g) => ({ hex: hex(g.c), share: Math.round((g.n / total) * 1000) / 10 }));
  return { width, height, palette, lightness };
}
