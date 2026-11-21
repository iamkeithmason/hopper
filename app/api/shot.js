// Page screenshots for Hopper (hopper-shot). hopper-api calls this with a page address and gets back
// the first screen and the whole page as JPEGs, so a saved page keeps its layout, not just its images.
// Headless Chromium (@sparticuz/chromium) with puppeteer-core, on the free Vercel project the app already uses.
//
// Auth: the x-shot-token header, checked by sha256 against SHOT_TOKEN_SHA256. The token itself lives only in
// Supabase Vault ('hopper_shot_token'); this project holds just its hash.
// POST { url, width?: 1440, height?: 900, full?: true }
//   -> { first, full, phone, width, height, full_height, full_scale, clipped, title, final_url, figures, videos }
//   (images as base64 JPEG). The whole page is stitched from screen-sized frames taken while scrolling, so fixed
//   backgrounds and sticky layers render as a reader sees them (a single tall capture loses them). figures lists the
//   six largest images on the page by rendered area at this width, in page order, with address, alt text, caption,
//   rendered size and distance from the top; videos counts video players. motion holds up to two motion strips
//   ({ where, top, image, changed_pct }: three frames a second apart, side by side), only for parts that move.
//   Pass motion: false to skip them.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

// The Claude API takes images up to 8000 px on a side and 5 MB, and the design read sends the stored image as is,
// so the full-page shot stays inside both. Pages taller than 8000 px are shot scaled down (whole page, smaller), but
// never below 40%: past that the page is cut instead, and the response says so.
const MAX_FULL_HEIGHT = 8000;
const MIN_SCALE = 0.4;
const MAX_BYTES = 4_800_000;

chromium.setGraphicsMode = false;

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

// Only public web pages: no local or private addresses.
function allowed(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (!["http:", "https:"].includes(u.protocol)) return false;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return false;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h.startsWith("[")) return false;
  return true;
}

// Two requests on one warm instance can race to unpack Chrome ("spawn ETXTBSY"). Wait and launch again.
// The Chrome package ships only Open Sans, so symbols such as arrows came out as empty boxes.
// DejaVu Sans (app/fonts) covers them. fontconfig reads /var/task/fonts, where Vercel should place app/fonts;
// copying into /tmp/fonts as well makes sure, whatever the bundle layout.
async function addFonts() {
  const dir = "/tmp/fonts";
  for (const f of ["DejaVuSans.ttf", "DejaVuSans-Bold.ttf"]) {
    const to = `${dir}/${f}`;
    if (existsSync(to)) continue;
    try {
      mkdirSync(dir, { recursive: true });
      copyFileSync(new URL(`../fonts/${f}`, import.meta.url), to);
    } catch (e) { console.error("font copy failed", f, String(e)); }
  }
}

async function launch(width, height) {
  const executablePath = await chromium.executablePath();
  await addFonts();
  for (let i = 0; ; i++) {
    try {
      return await puppeteer.launch({
        args: await puppeteer.defaultArgs({ args: chromium.args, headless: "shell" }),
        defaultViewport: { width, height, deviceScaleFactor: 1 },
        executablePath,
        headless: "shell",
      });
    } catch (e) {
      if (i >= 3 || !/ETXTBSY|EBUSY/.test(String(e?.message ?? e))) throw e;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
}

// The largest images on the page as a reader at this width sees them, and how many video players it holds.
async function pageFigures(page) {
  return await page.evaluate(() => {
    const seen = new Set();
    const figs = [];
    for (const img of document.images) {
      const src = img.currentSrc || img.src;
      if (!src || !/^https?:/.test(src) || seen.has(src)) continue;
      const r = img.getBoundingClientRect();
      const st = getComputedStyle(img);
      if (r.width < 240 || r.height < 160 || st.visibility === "hidden" || st.display === "none") continue;
      seen.add(src);
      const fig = img.closest("figure");
      const cap = (fig?.querySelector("figcaption")?.innerText ?? "").trim();
      figs.push({ src, alt: (img.alt ?? "").trim().slice(0, 300), caption: cap.slice(0, 400),
        width: Math.round(r.width), height: Math.round(r.height), top: Math.round(r.top + window.scrollY),
        natural: `${img.naturalWidth}x${img.naturalHeight}` });
    }
    const largest = figs.sort((a, b) => b.width * b.height - a.width * a.height).slice(0, 6).sort((a, b) => a.top - b.top);
    const videos = document.querySelectorAll("video").length
      + [...document.querySelectorAll("iframe")].filter((f) => /youtube|vimeo|loom|wistia/i.test(f.src)).length;
    return { figures: largest, videos };
  });
}

// The whole page, stitched from screen-sized frames taken while scrolling, scaled by `scale` and cut at `h` px.
// Frames keep fixed backgrounds and sticky layers as a reader sees them. Small fixed or sticky elements (headers,
// chat buttons) are hidden after the first frame so they don't repeat down the page; large ones (backdrops) stay.
async function stitch(browser, page, width, height, h, scale) {
  const frames = [];
  for (let y = 0; y < h; y += height) {
    const top = Math.min(y, Math.max(0, h - height));
    await page.evaluate((t) => window.scrollTo(0, t), top);
    await new Promise((r) => setTimeout(r, 220));
    const real = await page.evaluate(() => window.scrollY);
    frames.push({ y: real, data: (await page.screenshot({ type: "jpeg", quality: 80 })).toString("base64") });
    if (y === 0) {
      await page.evaluate((vh) => {
        for (const el of document.querySelectorAll("body *")) {
          const s = getComputedStyle(el);
          if ((s.position === "fixed" || s.position === "sticky") && el.getBoundingClientRect().height < vh * 0.4) {
            el.style.setProperty("visibility", "hidden", "important");
          }
        }
      }, height);
    }
    if (top + height >= h) break;
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  // Composite in a blank page's canvas: the frames go in as JPEG data, the stitched page comes out the same way.
  const sheet = await browser.newPage();
  try {
    const W = Math.round(width * scale), H = Math.round(h * scale);
    for (const quality of [0.72, 0.58, 0.45]) {
      const b64 = await sheet.evaluate(async (frames, W, H, scale, q) => {
        const c = document.createElement("canvas");
        c.width = W; c.height = H;
        const g = c.getContext("2d");
        // Later frames are drawn first, so an earlier frame (the first screen, with its header) wins any overlap.
        for (const f of [...frames].reverse()) {
          const img = new Image();
          img.src = `data:image/jpeg;base64,${f.data}`;
          await img.decode();
          g.drawImage(img, 0, Math.round(f.y * scale), W, Math.round(img.height * scale));
        }
        return c.toDataURL("image/jpeg", q).split(",")[1];
      }, frames, W, H, scale, quality);
      const buf = Buffer.from(b64, "base64");
      if (buf.length <= MAX_BYTES) return buf;
    }
    return null;
  } finally {
    await sheet.close().catch(() => {});
  }
}

// Motion strips: the stills are taken with reduced motion on (so text isn't caught mid-fade); then motion is turned
// back on and three frames are taken a second apart, of the first screen and, when the page has one further down, of its
// first video (muted, asked to play). The frames go side by side at half size, left to right. A strip is kept only when
// its frames differ (more than 0.4% of a small greyscale copy changes), so still pages get none.
// Animations a page starts from script only when it loads without reduced motion won't show; CSS ones and videos do.
const MOTION_GAP_MS = 1000;
export async function motionStrips(browser, page, width, height) {
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
  const spots = [{ where: "first screen", top: 0 }];
  const video = await page.evaluate(() => {
    const v = [...document.querySelectorAll("video, iframe")].find((el) => el.tagName === "VIDEO" || /youtube|vimeo|loom|wistia/i.test(el.src));
    if (!v) return null;
    const r = v.getBoundingClientRect();
    return Math.max(0, Math.round(r.top + window.scrollY - Math.max(0, (window.innerHeight - r.height) / 2)));
  }).catch(() => null);
  if (video != null && video > height * 0.5) spots.push({ where: "first video", top: video });
  // All frames first, then the compositing tab: a page in a background tab stops painting, and screenshots of it hang.
  const shots = [];
  try {
    for (const spot of spots) {
      await page.evaluate((t) => window.scrollTo(0, t), spot.top);
      await page.evaluate(() => document.querySelectorAll("video").forEach((v) => { v.muted = true; v.play?.().catch(() => {}); })).catch(() => {});
      await new Promise((r) => setTimeout(r, 500));
      const top = await page.evaluate(() => Math.round(window.scrollY));
      const frames = [];
      for (let i = 0; i < 3; i++) {
        if (i) await new Promise((r) => setTimeout(r, MOTION_GAP_MS));
        frames.push((await page.screenshot({ type: "jpeg", quality: 72 })).toString("base64"));
      }
      shots.push({ spot, top, frames });
    }
  } finally {
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  }
  const strips = [];
  const sheet = await browser.newPage();
  try {
    for (const { spot, top, frames } of shots) {
      const out = await sheet.evaluate(async (frames, w, h) => {
        const imgs = await Promise.all(frames.map(async (f) => { const im = new Image(); im.src = `data:image/jpeg;base64,${f}`; await im.decode(); return im; }));
        // How much changes: compare each later frame with the first on a 96 px wide greyscale copy.
        const tw = 96, th = Math.max(1, Math.round((96 * h) / w));
        const grey = (im) => {
          const c = document.createElement("canvas"); c.width = tw; c.height = th;
          const g = c.getContext("2d"); g.drawImage(im, 0, 0, tw, th);
          const d = g.getImageData(0, 0, tw, th).data, o = new Float32Array(tw * th);
          for (let i = 0; i < o.length; i++) o[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
          return o;
        };
        const base = grey(imgs[0]);
        let changed = 0;
        for (const im of imgs.slice(1)) {
          const g = grey(im);
          let n = 0;
          for (let i = 0; i < g.length; i++) if (Math.abs(g[i] - base[i]) > 24) n++;
          changed = Math.max(changed, n / g.length);
        }
        const fw = Math.round(w / 2), fh = Math.round(h / 2), gap = 8;
        const c = document.createElement("canvas");
        c.width = fw * 3 + gap * 2; c.height = fh;
        const g = c.getContext("2d");
        g.fillStyle = "#8a8a8a"; g.fillRect(0, 0, c.width, c.height);
        imgs.forEach((im, i) => g.drawImage(im, i * (fw + gap), 0, fw, fh));
        return { changed, b64: c.toDataURL("image/jpeg", 0.75).split(",")[1] };
      }, frames, width, height);
      if (out.changed > 0.004) strips.push({ where: spot.where, top, image: out.b64, changed_pct: Math.round(out.changed * 1000) / 10 });
    }
  } finally {
    await sheet.close().catch(() => {});
  }
  return strips;
}

// One attempt at a page. lite (the retry after a crash) skips the scroll-through and keeps the whole-page shot
// to half size or less, which needs far less memory on image-heavy pages.
export async function capture(url, width, height, wantFull, lite, wantMotion = false) {
  let browser, stage = "launch";
  const t0 = Date.now();
  const out = { first: null, full: null, fullHeight: null, clipped: false, scale: 1, title: null, finalUrl: url, status: null, motion: [] };
  try {
    browser = await launch(width, height);
    stage = "load";
    const page = await browser.newPage();
    page.on("error", (e) => console.error("page crashed", url, String(e)));
    // Many sites skip their entrance animations under reduced motion, so text isn't caught mid-fade.
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0 Safari/537.36 Hopper/1.0");
    await page.setExtraHTTPHeaders({ "accept-language": "en-GB,en;q=0.9" });
    const resp = await page.goto(url, { waitUntil: "networkidle2", timeout: lite ? 15000 : 25000 }).catch(() => null);
    if (!resp) await page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 }).catch(() => {});
    out.status = resp?.status() ?? null;

    if (!lite) {
      // Scroll through once so lazy images and scroll-triggered sections load, then back to the top.
      await page.evaluate(async () => {
        const step = Math.max(400, Math.floor(window.innerHeight * 0.8));
        const end = Math.min(document.documentElement.scrollHeight, 8000);
        for (let y = 0; y < end; y += step) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); }
        window.scrollTo(0, 0);
      });
      await page.waitForNetworkIdle({ idleTime: 500, timeout: 6000 }).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 600));

    stage = "first screen";
    out.first = await page.screenshot({ type: "jpeg", quality: 82 });
    out.title = await page.title().catch(() => null);
    out.finalUrl = page.url();

    stage = "figures";
    Object.assign(out, await pageFigures(page).catch((e) => { console.error("figures failed", url, String(e)); return {}; }));

    if (wantFull) {
      stage = "full page";
      out.fullHeight = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0));
      out.scale = Math.max(Math.min(lite ? 0.5 : 1, MAX_FULL_HEIGHT / out.fullHeight), MIN_SCALE);
      const h = Math.min(out.fullHeight, Math.floor(MAX_FULL_HEIGHT / out.scale));
      out.clipped = h < out.fullHeight;
      out.full = await stitch(browser, page, width, height, h, out.scale);
    }
    // Motion last, and only with time to spare: it takes up to eight seconds, and the phone screen comes after it.
    if (wantMotion && !lite && Date.now() - t0 < 25000) {
      stage = "motion";
      out.motion = await motionStrips(browser, page, width, height).catch((e) => { console.error("motion failed", url, String(e)); return []; });
    }
    return out;
  } catch (e) {
    out.error = String(e?.message ?? e).slice(0, 300);
    out.stage = stage;
    console.error("shot failed", lite ? "(lite)" : "", stage, url, out.error);
    return out;
  } finally {
    await browser?.close().catch(() => {});
  }
}

// The first screen on a phone: 390 x 844 at 2x, with a phone browser's user agent, so sites serve their mobile layout.
// Its own browser, so a crash here never costs the desktop shots.
const PHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1 Hopper/1.0";
export async function capturePhone(url) {
  let browser;
  try {
    browser = await launch(390, 844);
    const page = await browser.newPage();
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    await page.setUserAgent(PHONE_UA);
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.setExtraHTTPHeaders({ "accept-language": "en-GB,en;q=0.9" });
    const resp = await page.goto(url, { waitUntil: "networkidle2", timeout: 15000 }).catch(() => null);
    if (!resp) await page.waitForNetworkIdle({ idleTime: 500, timeout: 4000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 600));
    return { phone: await page.screenshot({ type: "jpeg", quality: 80 }), title: await page.title().catch(() => null) };
  } catch (e) {
    const error = String(e?.message ?? e).slice(0, 300);
    console.error("phone shot failed", url, error);
    return { phone: null, error };
  } finally {
    await browser?.close().catch(() => {});
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const want = process.env.SHOT_TOKEN_SHA256;
  const tok = req.headers["x-shot-token"];
  if (!want || typeof tok !== "string" || sha256(tok) !== want) return res.status(401).json({ error: "unauthorised" });

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body ?? {});
  const url = String(body.url ?? "");
  if (!allowed(url)) return res.status(400).json({ error: "give a public http(s) address" });
  const width = Math.min(Math.max(Number(body.width) || 1440, 360), 1920);
  const height = Math.min(Math.max(Number(body.height) || 900, 600), 1400);
  const wantFull = body.full !== false;
  const wantDesktop = body.desktop !== false;
  const wantPhone = body.phone !== false;
  const wantMotion = body.motion !== false;
  const started = Date.now();

  // Headless Chrome sometimes dies mid-shot on heavy pages ("Target closed"). Try once more in lite mode,
  // and keep whichever attempt got further: a first screen on its own is still worth keeping.
  let r = { first: null, full: null, fullHeight: null, clipped: false, scale: 1, title: null, finalUrl: url, status: null };
  if (wantDesktop) {
    r = await capture(url, width, height, wantFull, false, wantMotion);
    if (r.error || (wantFull && !r.full)) {
      const again = await capture(url, width, height, wantFull, true);
      if ((again.first && !r.first) || (again.full && !r.full)) r = { ...again, first: again.first ?? r.first };
    }
  }
  // The phone screen comes last and only while there's time left in the function's 60 seconds.
  let phone = null, phoneError = null;
  if (wantPhone && Date.now() - started < 38000) {
    const p = await capturePhone(url);
    phone = p.phone;
    phoneError = p.error ?? null;
    r.title = r.title ?? p.title ?? null;
  }
  if (!r.first && !phone) return res.status(502).json({ error: r.error ?? phoneError ?? "no screenshot", stage: r.stage ?? (phoneError ? "phone" : undefined) });
  return res.status(200).json({
    first: r.first ? Buffer.from(r.first).toString("base64") : null,
    full: r.full ? Buffer.from(r.full).toString("base64") : null,
    phone: phone ? Buffer.from(phone).toString("base64") : null,
    width, height, full_height: r.fullHeight, full_scale: Math.round(r.scale * 100) / 100, clipped: r.clipped,
    title: r.title, final_url: r.finalUrl, status: r.status, figures: r.figures ?? [], videos: r.videos ?? null,
    motion: r.motion ?? [],
  });
}
