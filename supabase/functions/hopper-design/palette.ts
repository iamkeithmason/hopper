// Measured palette for one image: real pixel colours, so hex values are never guessed by the model.
// Decode, sample about 160 pixels along the long side (a stride, no resize: edge functions have little CPU),
// median-cut into up to 16 boxes,
// merge boxes that look alike (CIE76 distance under 10), and keep colours covering at least 1%.
import { decode } from "https://deno.land/x/imagescript@1.3.0/mod.ts";

export type Swatch = { hex: string; share: number };
// unsampled says why there is no palette: "large" (too many pixels to decode in time) or "format" (the decoder
// can't read it: imagescript has no WebP decoder). Either way the image still gets a read, just without hex values.
export type Measured = { width: number; height: number; palette: Swatch[]; lightness: number | null; sampled: boolean; unsampled?: "large" | "format" };

// Above this many pixels, decoding runs past the edge function's compute limit, so colours are not sampled.
const MAX_PIXELS = 3_000_000;

// Width and height from a JPEG's frame header, without decoding it. Null if not found.
export function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    // SOF0-SOF15 carry the frame size, except DHT (C4), JPG (C8) and DAC (CC).
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
    }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    i += 2 + ((b[i + 2] << 8) | b[i + 3]);
  }
  return null;
}

// Width and height from the header of a JPEG, PNG, GIF or WebP, without decoding. Null if not found.
export function imageSize(b: Uint8Array): { width: number; height: number } | null {
  const j = jpegSize(b);
  if (j) return j;
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
  } catch (_) { /* unreadable header */ }
  return null;
}

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
  const size = imageSize(bytes);
  if (size && size.width * size.height > MAX_PIXELS) return { ...size, palette: [], lightness: null, sampled: false, unsampled: "large" };
  let img: any;
  try { img = await decode(bytes); } catch (_) {
    // WebP (and anything else imagescript can't decode): read it without a measured palette rather than not at all.
    // Without this, the sweep picks the same undecodable images first every time and stalls.
    return { ...(size ?? { width: 0, height: 0 }), palette: [], lightness: null, sampled: false, unsampled: "format" };
  }
  const width = img.width, height = img.height;
  const step = Math.max(1, Math.ceil(Math.max(width, height) / 160));
  const bm: Uint8ClampedArray = img.bitmap;
  const px: Px[] = [];
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      if (bm[i + 3] > 127) px.push([bm[i], bm[i + 1], bm[i + 2]]);
    }
  }
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
  return { width, height, palette, lightness, sampled: true };
}
