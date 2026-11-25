// Page measurements for benchmark captures (HOP-55, 56, 57), taken in the same headless Chrome as the screenshots.
// shot.js calls these for { measure: "motion" } and { measure: "type" }; hopper-api asks for both side by side after
// a desktop capture, each in its own function call, so neither eats the screenshots' 60 seconds.
// The underscore keeps Vercel from serving this file as a route of its own.
//
// motion: the page is loaded with motion on and watched from navigation, so entrance motion is caught (HOP-56).
//   Every animation the browser runs (CSS animations, CSS transitions, Web Animations, which is what Framer Motion and
//   Motion One use) is read from document.getAnimations() ten times a second: its duration, delay, easing, iterations
//   and what it moves, and how far. Script-driven motion that writes inline styles every frame (GSAP, anime.js) is
//   caught by watching style attributes. The page is then scrolled in steps to catch scroll reveals, and loaded again
//   with reduced motion forced to see what the site drops. Three-frame strips are kept of the entrance and of the
//   first scroll reveal, only when the frames differ.
// type: the page's distinct text treatments (family, size, weight, line height, tracking, case) with the roles they
//   are used for and how often, and its icon sizes with the box each sits in, at 1440 and at 390 (a phone).

const STRIP_GAP = [0, 600, 1500]; // ms after the page first appears
const MAX_RECORDS = 400;

// Installed before any page script runs. Records live on window.__hm; nothing leaves the page until read.
function recorder() {
  const hm = (window.__hm = { t0: performance.now(), phase: "load", scrollY: 0, anims: [], js: new Map(), seen: new WeakSet(), events: 0 });
  const desc = (el) => {
    if (!el || el.nodeType !== 1) return null;
    const tag = el.tagName.toLowerCase();
    const sem = el.closest("h1,h2,h3,h4,h5,h6,p,li,a,button,figure,img,video,nav,header,footer,section,main");
    const role = sem ? sem.tagName.toLowerCase() : tag;
    const r = el.getBoundingClientRect();
    const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/)[0] || "" : "";
    return { el: tag + (cls ? "." + cls.slice(0, 40) : ""), role, top: Math.round(r.top + window.scrollY), w: Math.round(r.width), h: Math.round(r.height),
      text: (el.innerText || el.alt || "").trim().replace(/\s+/g, " ").slice(0, 40) || undefined };
  };
  const px = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
  // How far a transform moves: translate x/y in px from translate(), translate3d(), translateX/Y() or matrix().
  const travel = (t) => {
    if (!t || t === "none") return { x: 0, y: 0, scale: 1, rotate: 0 };
    const o = { x: 0, y: 0, scale: 1, rotate: 0 };
    let m;
    if ((m = t.match(/matrix\(([^)]+)\)/))) { const v = m[1].split(",").map(Number); o.x = v[4]; o.y = v[5]; o.scale = Math.hypot(v[0], v[1]); return o; }
    if ((m = t.match(/matrix3d\(([^)]+)\)/))) { const v = m[1].split(",").map(Number); o.x = v[12]; o.y = v[13]; o.scale = Math.hypot(v[0], v[1]); return o; }
    if ((m = t.match(/translate(?:3d)?\(\s*([-\d.]+)(px|%)?\s*(?:,\s*([-\d.]+)(px|%)?)?/))) { o.x = +m[1]; o.y = +(m[3] ?? 0); o.unit = m[2] === "%" || m[4] === "%" ? "%" : "px"; }
    if ((m = t.match(/translateX\(\s*([-\d.]+)(px|%)?/))) o.x = +m[1];
    if ((m = t.match(/translateY\(\s*([-\d.]+)(px|%)?/))) { o.y = +m[1]; if (m[2] === "%") o.unit = "%"; }
    if ((m = t.match(/scale\(\s*([-\d.]+)/))) o.scale = +m[1];
    if ((m = t.match(/rotate(?:Z)?\(\s*([-\d.]+)deg/))) o.rotate = +m[1];
    return o;
  };
  const read = (a) => {
    try {
      const eff = a.effect;
      const timing = eff?.getTiming?.() ?? {};
      const kfs = eff?.getKeyframes?.() ?? [];
      const props = [...new Set(kfs.flatMap((k) => Object.keys(k).filter((p) => !["offset", "computedOffset", "easing", "composite"].includes(p))))];
      const first = kfs[0] ?? {}, last = kfs[kfs.length - 1] ?? {};
      const a0 = travel(first.transform), a1 = travel(last.transform);
      const easing = timing.easing && timing.easing !== "linear" ? timing.easing : (first.easing && first.easing !== "linear" ? first.easing : timing.easing ?? null);
      const kind = a.constructor?.name === "CSSAnimation" ? "css-animation" : a.constructor?.name === "CSSTransition" ? "css-transition" : "web-animation";
      const name = a.animationName || a.transitionProperty || a.id || null;
      return {
        kind, name, start_ms: Math.round(performance.now() - hm.t0), phase: hm.phase, scroll_y: hm.scrollY,
        duration_ms: typeof timing.duration === "number" ? Math.round(timing.duration) : null, delay_ms: Math.round(timing.delay ?? 0),
        easing, iterations: timing.iterations === Infinity ? "infinite" : timing.iterations ?? 1, props,
        move_x: Math.round(a1.x - a0.x) || 0, move_y: Math.round(a1.y - a0.y) || 0, move_unit: a0.unit || a1.unit || "px",
        scale_from: a0.scale !== 1 ? Math.round(a0.scale * 100) / 100 : undefined, rotate: a1.rotate - a0.rotate || undefined,
        opacity: first.opacity != null || last.opacity != null ? [px(first.opacity ?? 1), px(last.opacity ?? 1)] : undefined,
        target: desc(eff?.target),
      };
    } catch { return null; }
  };
  const poll = () => {
    try {
      for (const a of document.getAnimations()) {
        if (hm.seen.has(a)) continue;
        hm.seen.add(a);
        if (hm.anims.length >= 400) continue;
        const r = read(a);
        if (r) hm.anims.push(r);
      }
    } catch { /* page not ready */ }
  };
  setInterval(poll, 100);
  document.addEventListener("animationstart", () => { hm.events++; poll(); }, true);
  document.addEventListener("transitionrun", () => { hm.events++; poll(); }, true);
  // Script-driven motion: an element whose inline transform or opacity is rewritten many times.
  const watch = () => {
    new MutationObserver((muts) => {
      const now = Math.round(performance.now() - hm.t0);
      for (const m of muts) {
        const el = m.target;
        if (!(el instanceof HTMLElement || el instanceof SVGElement)) continue;
        const s = el.style;
        if (!s || (!s.transform && !s.opacity && !s.translate)) continue;
        let j = hm.js.get(el);
        if (!j) { if (hm.js.size >= 300) continue; j = { first_ms: now, phase: hm.phase, scroll_y: hm.scrollY, n: 0, t0: s.transform || s.translate, o0: s.opacity }; hm.js.set(el, j); }
        j.n++; j.last_ms = now; j.t1 = s.transform || s.translate; j.o1 = s.opacity;
      }
    }).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ["style"] });
  };
  if (document.documentElement) watch(); else document.addEventListener("readystatechange", watch, { once: true });
  hm.collect = () => {
    poll();
    const js = [];
    for (const [el, j] of hm.js) {
      if (j.n < 5 || j.last_ms - j.first_ms < 100) continue;
      const a0 = travel(j.t0), a1 = travel(j.t1);
      js.push({ kind: "script", name: null, start_ms: j.first_ms, phase: j.phase, scroll_y: j.scroll_y, duration_ms: j.last_ms - j.first_ms,
        delay_ms: 0, easing: null, iterations: 1, props: [j.t0 || j.t1 ? "transform" : null, j.o0 || j.o1 ? "opacity" : null].filter(Boolean),
        move_x: Math.round(a1.x - a0.x) || 0, move_y: Math.round(a1.y - a0.y) || 0, move_unit: a0.unit || a1.unit || "px",
        opacity: j.o0 || j.o1 ? [px(j.o0 ?? 1), px(j.o1 ?? 1)] : undefined, frames: j.n, target: desc(el) });
    }
    return { anims: hm.anims, js, events: hm.events };
  };
}

// Which motion libraries the page carries, from its globals, script addresses and markup.
function libraries() {
  const srcs = [...document.scripts].map((s) => s.src || "").join(" ").toLowerCase();
  const has = (sel) => { try { return !!document.querySelector(sel); } catch { return false; } };
  const w = window;
  const out = [];
  const add = (name, yes) => { if (yes) out.push(name); };
  add("GSAP", w.gsap || w.TweenMax || /gsap|greensock|tweenmax/.test(srcs));
  add("GSAP ScrollTrigger", w.ScrollTrigger || /scrolltrigger/.test(srcs));
  add("Framer (site)", has("[data-framer-name],[data-framer-component-type],[data-framer-hydrate-v2]") || /framerusercontent|framer\.com\/m\//.test(srcs));
  add("Framer Motion", has("[data-projection-id]") || /framer-motion/.test(srcs));
  add("Motion One", /motion(\.dev|one)|\/motion@/.test(srcs));
  add("Lenis smooth scroll", w.lenis || w.Lenis || document.documentElement.classList.contains("lenis") || /lenis/.test(srcs));
  add("Locomotive Scroll", has("[data-scroll-container]") || /locomotive/.test(srcs));
  add("AOS", has("[data-aos]") || /\baos\b/.test(srcs));
  add("Webflow interactions", has("html[data-wf-page]") && has("[data-w-id]"));
  add("Lottie", w.lottie || w.bodymovin || has("lottie-player,dotlottie-player") || /lottie|bodymovin/.test(srcs));
  add("anime.js", w.anime || /anime(\.min)?\.js/.test(srcs));
  add("Three.js", w.THREE || /three(\.module)?(\.min)?\.js/.test(srcs));
  add("Swiper", w.Swiper || has(".swiper"));
  add("Barba page transitions", w.barba || /barba/.test(srcs));
  add("Splitting / SplitText", w.SplitText || w.Splitting || has("[data-splitting]"));
  return out;
}

const median = (xs) => { const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const tally = (xs) => Object.entries(xs.reduce((m, x) => (x == null ? m : (m[x] = (m[x] ?? 0) + 1, m)), {})).sort((a, b) => b[1] - a[1]);

// Groups of three or more alike animations (same kind, property set and duration) whose starts step evenly: a stagger.
function staggers(list) {
  const groups = new Map();
  for (const a of list) {
    const key = [a.phase, a.kind, a.name ?? "", a.props.join("+"), a.duration_ms].join("|");
    (groups.get(key) ?? groups.set(key, []).get(key)).push(a);
  }
  const out = [];
  for (const g of groups.values()) {
    if (g.length < 3) continue;
    const starts = g.map((a) => a.start_ms + a.delay_ms).sort((a, b) => a - b);
    const gaps = starts.slice(1).map((s, i) => s - starts[i]).filter((d) => d > 0);
    if (gaps.length < 2) continue;
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const sd = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length);
    if (mean >= 20 && mean <= 600 && sd <= mean * 0.35) {
      out.push({ items: g.length, step_ms: Math.round(median(gaps)), duration_ms: g[0].duration_ms, props: g[0].props, phase: g[0].phase,
        roles: tally(g.map((a) => a.target?.role)).slice(0, 3).map(([r]) => r) });
    }
  }
  return out.sort((a, b) => b.items - a.items).slice(0, 6);
}

// A short account of one phase's motion, for get_reference and the design read to quote.
function summarise(list) {
  const finite = list.filter((a) => a.iterations !== "infinite");
  const moving = finite.filter((a) => a.move_x || a.move_y);
  return {
    count: list.length, looping: list.length - finite.length,
    kinds: Object.fromEntries(tally(list.map((a) => a.kind))),
    duration_ms: finite.length ? { median: median(finite.map((a) => a.duration_ms)), min: Math.min(...finite.map((a) => a.duration_ms ?? Infinity)), max: Math.max(...finite.map((a) => a.duration_ms ?? 0)) } : null,
    delay_ms: finite.length ? { median: median(finite.map((a) => a.delay_ms)), max: Math.max(...finite.map((a) => a.delay_ms)) } : null,
    easings: tally(finite.map((a) => a.easing)).slice(0, 4).map(([e, n]) => ({ easing: e, uses: n })),
    properties: tally(list.flatMap((a) => a.props)).slice(0, 6).map(([p, n]) => ({ property: p, uses: n })),
    travel_px: moving.length ? { median_y: median(moving.map((a) => Math.abs(a.move_y))), median_x: median(moving.map((a) => Math.abs(a.move_x))), max: Math.max(...moving.map((a) => Math.max(Math.abs(a.move_x), Math.abs(a.move_y)))) } : null,
    fades: finite.filter((a) => a.opacity && a.opacity[0] !== a.opacity[1]).length,
    roles: tally(list.map((a) => a.target?.role)).slice(0, 6).map(([r, n]) => ({ role: r, uses: n })),
    staggers: staggers(finite),
  };
}

// Three frames side by side at half size, and how much of a small greyscale copy changes between them.
async function strip(browser, frames, width, height) {
  const sheet = await browser.newPage();
  try {
    return await sheet.evaluate(async (frames, w, h) => {
      const imgs = await Promise.all(frames.map(async (f) => { const im = new Image(); im.src = `data:image/jpeg;base64,${f}`; await im.decode(); return im; }));
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
  } finally {
    await sheet.close().catch(() => {});
  }
}

const shoot = async (page) => (await page.screenshot({ type: "jpeg", quality: 70 })).toString("base64");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function openPage(browser, url, { reduce, ua, record = true }) {
  const page = await browser.newPage();
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: reduce ? "reduce" : "no-preference" }]);
  await page.setUserAgent(ua);
  await page.setExtraHTTPHeaders({ "accept-language": "en-GB,en;q=0.9" });
  if (record) await page.evaluateOnNewDocument(recorder);
  return page;
}

// Scroll down in screen-and-a-bit steps, marking each step so animations that start are filed as scroll reveals.
// With frames, the first step where something starts and the view changes is kept as a strip.
async function scrollThrough(browser, page, width, height, { frames, steps, settle }) {
  let kept = null;
  const end = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => 0);
  for (let i = 1; i <= steps; i++) {
    const y = Math.round(i * height * 0.8);
    if (y > end - height * 0.5) break;
    const before = await page.evaluate(() => window.__hm ? window.__hm.anims.length + window.__hm.js.size : 0).catch(() => 0);
    await page.evaluate((y) => { if (window.__hm) { window.__hm.phase = "scroll"; window.__hm.scrollY = y; } window.scrollTo(0, y); }, y).catch(() => {});
    if (frames && !kept) {
      const shots = [await shoot(page)];
      await wait(400); shots.push(await shoot(page));
      await wait(500); shots.push(await shoot(page));
      const after = await page.evaluate(() => window.__hm.anims.length + window.__hm.js.size).catch(() => before);
      if (after > before) {
        const s = await strip(browser, shots, width, height);
        if (s.changed > 0.004) kept = { where: "first scroll reveal", top: y, image: s.b64, changed_pct: Math.round(s.changed * 1000) / 10 };
      }
    } else await wait(settle);
  }
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  return kept;
}

const clean = (a) => Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && !v.length)));

// HOP-55 and 56. Returns { motion, strips } or { error }.
export async function measureMotion(browser, url, width, height, ua, t0 = Date.now()) {
  const page = await openPage(browser, url, { reduce: false, ua });
  // Entrance: frames from the moment the page first has a document, before it settles.
  const frames = [];
  let status = null;
  const nav = page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 }).then((r) => { status = r?.status() ?? null; }).catch(() => {});
  await nav;
  const appeared = Date.now();
  for (const at of STRIP_GAP) {
    const lag = appeared + at - Date.now();
    if (lag > 0) await wait(lag);
    frames.push(await shoot(page).catch(() => null));
  }
  await page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 }).catch(() => {});
  await wait(800);
  const strips = [];
  if (frames.every(Boolean)) {
    const s = await strip(browser, frames, width, height);
    if (s.changed > 0.004) strips.push({ where: "first screen as it loads", top: 0, image: s.b64, changed_pct: Math.round(s.changed * 1000) / 10,
      times_ms: STRIP_GAP });
  }
  const reveal = await scrollThrough(browser, page, width, height, { frames: true, steps: 7, settle: 450 });
  if (reveal) strips.push(reveal);
  await wait(400);
  const rec = await page.evaluate(() => window.__hm?.collect()).catch(() => null);
  const libs = await page.evaluate(libraries).catch(() => []);
  await page.close().catch(() => {});
  if (!rec) return { error: "the page wouldn't run the motion recorder", status };
  const all = [...rec.anims, ...rec.js].sort((a, b) => a.start_ms - b.start_ms);

  // The same page with reduced motion forced: what the site keeps.
  let reduced = null;
  if (Date.now() - t0 < 40000) {
    const rp = await openPage(browser, url, { reduce: true, ua });
    await rp.goto(url, { waitUntil: "domcontentloaded", timeout: 12000 }).catch(() => {});
    await rp.waitForNetworkIdle({ idleTime: 500, timeout: 4000 }).catch(() => {});
    await wait(1200);
    await scrollThrough(browser, rp, width, height, { frames: false, steps: 4, settle: 350 });
    const r2 = await rp.evaluate(() => window.__hm?.collect()).catch(() => null);
    await rp.close().catch(() => {});
    if (r2) {
      const full = all.filter((a) => a.iterations !== "infinite").length;
      const kept = [...r2.anims, ...r2.js].filter((a) => a.iterations !== "infinite");
      reduced = { animations: kept.length, with_motion: full,
        honoured: full === 0 ? null : kept.length <= full * 0.3,
        still_moving: tally(kept.map((a) => a.target?.role)).slice(0, 4).map(([r]) => r) };
    }
  }
  const load = all.filter((a) => a.phase === "load"), scroll = all.filter((a) => a.phase === "scroll");
  return {
    status,
    strips,
    motion: {
      v: 1, measured_at: new Date().toISOString(), width,
      moves: all.length > 0, libraries: libs,
      entrance: summarise(load), scroll_reveals: summarise(scroll),
      trigger: load.length && scroll.length ? "load and scroll" : load.length ? "load" : scroll.length ? "scroll" : "none",
      reduced_motion: reduced,
      // The first 60 animations as measured, for a closer look.
      animations: all.slice(0, 60).map(clean),
      truncated: all.length > 60 || rec.anims.length >= MAX_RECORDS || undefined,
    },
  };
}

// HOP-57: text treatments and icons as rendered at this viewport.
function typeAndIcons() {
  const ROLE_SEL = "h1,h2,h3,h4,h5,h6,p,li,blockquote,figcaption,button,label,dt,dd,td,th,small,code,pre";
  const roleOf = (el) => {
    const a = el.closest("a");
    const zone = el.closest("nav") ? "nav" : el.closest("footer") ? "footer" : el.closest("header") ? "header" : null;
    const sem = el.closest(ROLE_SEL);
    let r = sem ? sem.tagName.toLowerCase() : a ? "a" : el.tagName.toLowerCase();
    if (a && r !== "button" && !/^h\d$/.test(r)) r = "a";
    if (zone && (r === "a" || r === "li" || r === "span" || r === "div")) r = `${zone} ${r === "li" ? "a" : r}`;
    return r;
  };
  const treatments = new Map();
  let total = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const done = new WeakSet();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.nodeValue.trim();
    if (!t) continue;
    const el = n.parentElement;
    if (!el || done.has(el) || el.closest("script,style,noscript,svg,template")) continue;
    done.add(el);
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none" || parseFloat(s.opacity) === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const size = Math.round(parseFloat(s.fontSize) * 10) / 10;
    const lh = s.lineHeight === "normal" ? "normal" : Math.round((parseFloat(s.lineHeight) / parseFloat(s.fontSize)) * 100) / 100;
    const ls = s.letterSpacing === "normal" ? 0 : Math.round((parseFloat(s.letterSpacing) / parseFloat(s.fontSize)) * 1000) / 1000;
    const upper = s.textTransform === "uppercase" || (t.length > 2 && t.length < 40 && t === t.toUpperCase() && /[A-Z]/.test(t));
    const family = s.fontFamily.split(",")[0].replace(/["']/g, "").trim();
    const key = [family, size, s.fontWeight, lh, ls, upper ? "upper" : "", s.fontStyle === "italic" ? "italic" : ""].join("|");
    let tr = treatments.get(key);
    if (!tr) {
      tr = { family, stack: s.fontFamily.slice(0, 120), size_px: size, weight: Number(s.fontWeight) || s.fontWeight, line_height: lh, tracking_em: ls,
        uppercase: upper || undefined, italic: s.fontStyle === "italic" || undefined, uses: 0, chars: 0, roles: {}, first_top: Math.round(r.top + window.scrollY),
        sample: t.replace(/\s+/g, " ").slice(0, 40), colour: s.color };
      treatments.set(key, tr);
    }
    tr.uses++; tr.chars += t.length; total += t.length;
    let role = roleOf(el);
    if (upper && !/^h\d$/.test(role)) role += " (uppercase)";
    tr.roles[role] = (tr.roles[role] ?? 0) + 1;
  }
  const list = [...treatments.values()].filter((t) => t.chars >= 2);
  const body = list.filter((t) => !t.uppercase).sort((a, b) => b.chars - a.chars)[0];
  const sizes = [...new Set(list.map((t) => t.size_px))].sort((a, b) => b - a);
  const out = list.sort((a, b) => b.size_px - a.size_px || b.chars - a.chars).slice(0, 24).map((t) => ({
    ...t, roles: Object.entries(t.roles).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([role, uses]) => ({ role, uses })),
    share: total ? Math.round((t.chars / total) * 1000) / 10 : 0,
  }));
  // Icons: inline SVGs (not nested), icon-font glyphs and small SVG images, with the box each sits in.
  const icons = new Map();
  const iconFont = /icon|awesome|material|symbols|phosphor|lucide|feather|remix/i;
  const els = [...document.querySelectorAll("svg, i, span[class*='icon'], img[src$='.svg']")];
  for (const el of els) {
    if (el.tagName.toLowerCase() === "svg" && el.parentElement?.closest("svg")) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6 || r.width > 96 || r.height > 96) continue;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none") continue;
    const tag = el.tagName.toLowerCase();
    if ((tag === "i" || tag === "span") && !iconFont.test(s.fontFamily) && !iconFont.test(el.className || "")) continue;
    const kind = tag === "svg" ? "inline svg" : tag === "img" ? "svg image" : "icon font";
    const box = el.closest("a,button") ?? el.parentElement;
    const br = box?.getBoundingClientRect();
    const size = `${Math.round(r.width)}x${Math.round(r.height)}`;
    const boxSize = br ? `${Math.round(br.width)}x${Math.round(br.height)}` : null;
    const zone = el.closest("nav") ? "nav" : el.closest("footer") ? "footer" : el.closest("header") ? "header" : el.closest("button") ? "button" : el.closest("a") ? "link" : "content";
    const key = [kind, size, boxSize, zone].join("|");
    const ic = icons.get(key) ?? icons.set(key, { kind, size, box: boxSize, in: zone, uses: 0, stroke: tag === "svg" ? (s.strokeWidth !== "1px" ? s.strokeWidth : undefined) : undefined }).get(key);
    ic.uses++;
  }
  return {
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    body: body ? { family: body.family, size_px: body.size_px, line_height: body.line_height } : null,
    sizes_px: sizes.slice(0, 16),
    scale_ratios: body ? sizes.slice(0, 12).map((s) => Math.round((s / body.size_px) * 100) / 100) : [],
    families: [...new Set(list.map((t) => t.family))].slice(0, 8),
    treatments: out, treatment_count: list.length,
    icons: [...icons.values()].sort((a, b) => b.uses - a.uses).slice(0, 16),
  };
}

async function readType(browser, url, viewport, ua) {
  const page = await browser.newPage();
  try {
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    await page.setUserAgent(ua);
    await page.setViewport(viewport);
    await page.setExtraHTTPHeaders({ "accept-language": "en-GB,en;q=0.9" });
    const resp = await page.goto(url, { waitUntil: "networkidle2", timeout: 15000 }).catch(() => null);
    if (!resp) await page.waitForNetworkIdle({ idleTime: 500, timeout: 4000 }).catch(() => {});
    await page.evaluate(() => document.fonts?.ready).catch(() => {});
    // Scroll through first, so text that only appears on scroll (reveals, lazy sections) is counted.
    await page.evaluate(async () => {
      const step = Math.max(400, Math.floor(window.innerHeight * 0.8));
      const end = Math.min(document.documentElement.scrollHeight, 12000);
      for (let y = 0; y < end; y += step) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 150)); }
      window.scrollTo(0, 0);
    }).catch(() => {});
    await wait(500);
    return await page.evaluate(typeAndIcons);
  } finally {
    await page.close().catch(() => {});
  }
}

// HOP-57. Returns { type_scale } with desktop and phone readings (either may be null if that load failed).
export async function measureType(browser, url, desktopUa, phoneUa, t0 = Date.now()) {
  const desktop = await readType(browser, url, { width: 1440, height: 900, deviceScaleFactor: 1 }, desktopUa)
    .catch((e) => ({ error: String(e?.message ?? e).slice(0, 200) }));
  const phone = Date.now() - t0 < 35000
    ? await readType(browser, url, { width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true }, phoneUa)
      .catch((e) => ({ error: String(e?.message ?? e).slice(0, 200) }))
    : null;
  return { type_scale: { v: 1, measured_at: new Date().toISOString(), at_1440: desktop, at_390: phone } };
}
