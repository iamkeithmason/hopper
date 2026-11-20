// Page screenshots for Hopper (hopper-shot). hopper-api calls this with a page address and gets back
// the first screen and the whole page as JPEGs, so a saved page keeps its layout, not just its images.
// Headless Chromium (@sparticuz/chromium) with puppeteer-core, on the free Vercel project the app already uses.
//
// Auth: the x-shot-token header, checked by sha256 against SHOT_TOKEN_SHA256. The token itself lives only in
// Supabase Vault ('hopper_shot_token'); this project holds just its hash.
// POST { url, width?: 1440, height?: 900, full?: true }
//   -> { first, full, width, height, full_height, full_scale, clipped, title, final_url }  (images as base64 JPEG)
import { createHash } from "node:crypto";
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

  let browser, stage = "launch";
  try {
    browser = await puppeteer.launch({
      args: await puppeteer.defaultArgs({ args: chromium.args, headless: "shell" }),
      defaultViewport: { width, height, deviceScaleFactor: 1 },
      executablePath: await chromium.executablePath(),
      headless: "shell",
    });
    stage = "load";
    const page = await browser.newPage();
    page.on("error", (e) => console.error("page crashed", url, String(e)));
    // Many sites skip their entrance animations under reduced motion, so text isn't caught mid-fade.
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0 Safari/537.36 Hopper/1.0");
    await page.setExtraHTTPHeaders({ "accept-language": "en-GB,en;q=0.9" });
    const resp = await page.goto(url, { waitUntil: "networkidle2", timeout: 25000 }).catch(() => null);
    if (!resp) await page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 }).catch(() => {});

    // Scroll through once so lazy images and scroll-triggered sections load, then back to the top.
    await page.evaluate(async () => {
      const step = Math.max(400, Math.floor(window.innerHeight * 0.8));
      const end = Math.min(document.documentElement.scrollHeight, 8000);
      for (let y = 0; y < end; y += step) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); }
      window.scrollTo(0, 0);
    });
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 6000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 600));

    stage = "first screen";
    const first = await page.screenshot({ type: "jpeg", quality: 82 });

    let full = null, fullHeight = null, clipped = false, scale = 1;
    if (body.full !== false) {
      stage = "full page";
      // A full-page shot grows the viewport to the page's height, which stretches anything sized in vh
      // (a 100vh hero would fill the whole image). Pin such elements to their current pixel height first.
      fullHeight = await page.evaluate(() => {
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
      scale = Math.max(Math.min(1, MAX_FULL_HEIGHT / fullHeight), MIN_SCALE);
      const h = Math.min(fullHeight, Math.floor(MAX_FULL_HEIGHT / scale));
      clipped = h < fullHeight;
      for (const quality of [72, 58, 45]) {
        full = await page.screenshot({ type: "jpeg", quality, clip: { x: 0, y: 0, width, height: h, scale }, captureBeyondViewport: true });
        if (full.length <= MAX_BYTES) break;
      }
      if (full.length > MAX_BYTES) full = null;
    }

    return res.status(200).json({
      first: Buffer.from(first).toString("base64"),
      full: full ? Buffer.from(full).toString("base64") : null,
      width, height, full_height: fullHeight, full_scale: Math.round(scale * 100) / 100, clipped,
      title: await page.title().catch(() => null),
      final_url: page.url(),
      status: resp?.status() ?? null,
    });
  } catch (e) {
    console.error("shot failed", stage, url, String(e?.message ?? e));
    return res.status(502).json({ error: String(e?.message ?? e).slice(0, 300), stage });
  } finally {
    await browser?.close().catch(() => {});
  }
}
