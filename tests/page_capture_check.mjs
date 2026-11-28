// Page capture check (#71, #77, #79): the capture browser's own code against a local page that has a cookie modal over
// it, a sticky header, a skipped heading level, low-contrast text, small tap targets and one very tall section.
// Checks: the consent banner is declined ("Reject all", never "Accept all") and the page scrolls again; the page comes
// back as tiles at 1440 wide, one per section group, none taller than 2400 px, covering the page without gaps, with
// from= carrying on lower down; the type reading has contrast per treatment, the h2 to h4 break, calls to action in the
// first screen, and tap targets under 44 px at 390.
// Run from the app folder so puppeteer-core resolves:  cd app && npm install && node ../tests/page_capture_check.mjs
// CHROME=/path/to/chrome picks the browser (default: the Playwright Chromium in /opt/pw-browsers).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "../app/package.json"));
const puppeteer = require("puppeteer-core");
const { measureTiles, measureType, planTiles } = await import(path.join(here, "../app/api/_measure.js"));

const html = fs.readFileSync(path.join(here, "fixtures/capture-page.html"));
const srv = http.createServer((_, r) => { r.setHeader("content-type", "text/html"); r.end(html); }).listen(0);
const url = `http://127.0.0.1:${srv.address().port}/`;
const chrome = process.env.CHROME
  || ["/opt/pw-browsers/chromium/chrome-linux64/chrome", "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome"].find((p) => fs.existsSync(p));
const browser = await puppeteer.launch({ executablePath: chrome, args: ["--no-sandbox"], headless: "shell", defaultViewport: { width: 1440, height: 900 } });

let failed = 0;
const check = (ok, what, got) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok ? "" : `: ${JSON.stringify(got)}`}`); if (!ok) failed++; };
const UA = "Mozilla/5.0 Hopper-test";

try {
  // Planning alone: small sections group, a tall one splits, the end joins the last tile.
  const plan = planTiles([{ top: 0 }, { top: 80 }, { top: 860 }, { top: 1440 }, { top: 1920 }, { top: 5100 }, { top: 6080 }], 6380);
  check(plan.every((t, i) => t.bottom - t.top <= 2400 && (i === 0 || t.top === plan[i - 1].bottom)) && plan.at(-1).bottom === 6380,
    "tile plan covers the page in tiles of 2400 px or less", plan);

  const r = await measureTiles(browser, url, 1440, 900, UA, 0, Date.now());
  check(r.overlays?.action === "rejected" && r.overlays.clicked === "Reject all", "consent banner declined with Reject all", r.overlays);
  check(r.tiles?.length >= 3 && r.tiles.every((t) => t.height <= 2400 && t.image.length > 1000), "page comes back as tiles", r.tiles?.map((t) => t.height));
  check(r.tiles?.reduce((n, t) => n + t.height, 0) === r.page_height, "tiles cover the whole page", r.page_height);
  check(r.tiles?.[0]?.section === "Big hero", "first tile names its section", r.tiles?.[0]?.section);
  const later = await measureTiles(browser, url, 1440, 900, UA, 3000, Date.now());
  check(later.tiles?.[0]?.top <= 3000 && later.tiles[0].top + later.tiles[0].height > 3000 && later.tiles.length < r.tiles.length,
    "from= starts at the tile holding that point", later.tiles?.map((t) => t.top));

  const { type_scale: ts } = await measureType(browser, url, UA, UA, Date.now());
  const d = ts.at_1440, p = ts.at_390;
  check(d.overlays?.action === "rejected", "type reading also declines the banner", d.overlays);
  check(d.contrast_summary?.text_elements_below_aa >= 2, "low-contrast text counted", d.contrast_summary);
  check(d.facts?.headings?.order_breaks?.some((b) => b.from === "h2" && b.to === "h4"), "h2 to h4 break found", d.facts?.headings);
  check(d.facts?.ctas_above_fold?.list?.some((c) => c.text === "Get started") && !d.facts.ctas_above_fold.list.some((c) => /accept|reject/i.test(c.text)),
    "calls to action in the first screen, banner buttons not among them", d.facts?.ctas_above_fold);
  check(p?.facts?.tap_targets?.under_44 >= 1 && p.facts.tap_targets.smallest.some((t) => t.text === "tiny link"), "small tap targets at 390", p?.facts?.tap_targets);
  check(!d.facts?.tap_targets, "no tap-target count at 1440", d.facts?.tap_targets);
} finally {
  await browser.close();
  srv.close();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
