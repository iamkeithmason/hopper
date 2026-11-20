// Page screenshots for Hopper (hopper-shot). hopper-api calls this with a page address and gets back
// the first screen and the whole page as JPEGs, so a saved page keeps its layout, not just its images.
// Headless Chromium (@sparticuz/chromium) with puppeteer-core, on the free Vercel project the app already uses.
//
// Auth: the x-shot-token header, checked by sha256 against SHOT_TOKEN_SHA256. The token itself lives only in
// Supabase Vault ('hopper_shot_token'); this project holds just its hash.
// POST { url, width?: 1440, height?: 900, full?: true }
//   -> { first, full, width, height, full_height, full_scale, clipped, title, final_url }  (images as base64 JPEG)
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

// One attempt at a page. lite (the retry after a crash) skips the scroll-through and keeps the whole-page shot
// to half size or less, which needs far less memory on image-heavy pages.
export async function capture(url, width, height, wantFull, lite) {
  let browser, stage = "launch";
  const out = { first: null, full: null, fullHeight: null, clipped: false, scale: 1, title: null, finalUrl: url, status: null };
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

    if (wantFull) {
      stage = "full page";
      // A full-page shot grows the viewport to the page's height, which stretches anything sized in vh
      // (a 100vh hero would fill the whole image). Pin such elements to their current pixel height first.
      out.fullHeight = await page.evaluate(() => {
        const vh = window.innerHeight;
        for (const el of document.querySelectorAll("body *")) {
          const r = el.getBoundingClientRect();
          if (r.height >= vh * 0.6 && r.height <= vh * 1.05) {
            const s = getComputedStyle(el);
            if (s.position === "fixed") continue;
            el.style.setProperty("height", `${r.height}px`, "important");
            el.style.setProperty("min-height", `${r.height}px`, "important");
            el.style.setProperty("max-height", `${r.height}px`, "important");
          }
        }
        return Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
      });
      out.scale = Math.max(Math.min(lite ? 0.5 : 1, MAX_FULL_HEIGHT / out.fullHeight), MIN_SCALE);
      const h = Math.min(out.fullHeight, Math.floor(MAX_FULL_HEIGHT / out.scale));
      out.clipped = h < out.fullHeight;
      for (const quality of [72, 58, 45]) {
        out.full = await page.screenshot({ type: "jpeg", quality, clip: { x: 0, y: 0, width, height: h, scale: out.scale }, captureBeyondViewport: true });
        if (out.full.length <= MAX_BYTES) break;
      }
      if (out.full.length > MAX_BYTES) out.full = null;
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
  const started = Date.now();

  // Headless Chrome sometimes dies mid-shot on heavy pages ("Target closed"). Try once more in lite mode,
  // and keep whichever attempt got further: a first screen on its own is still worth keeping.
  let r = { first: null, full: null, fullHeight: null, clipped: false, scale: 1, title: null, finalUrl: url, status: null };
  if (wantDesktop) {
    r = await capture(url, width, height, wantFull, false);
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
    title: r.title, final_url: r.finalUrl, status: r.status,
  });
}
