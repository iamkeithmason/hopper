import { clearOverlays } from "./_overlays.js";

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
  // The entrance frames show the page as it arrives, banner and all; the scroll reveals come after the banner is gone.
  // Motion the banner itself makes as it goes is filed under its own phase, apart from the page's entrance.
  await page.evaluate(() => { if (window.__hm) window.__hm.phase = "overlay"; }).catch(() => {});
  const overlays = await clearOverlays(page);
  await wait(800);
  await page.evaluate(() => { if (window.__hm) window.__hm.phase = "load"; }).catch(() => {});
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
  const all = [...rec.anims, ...rec.js].filter((a) => a.phase !== "overlay").sort((a, b) => a.start_ms - b.start_ms);

  // The same page with reduced motion forced: what the site keeps.
  let reduced = null;
  if (Date.now() - t0 < 40000) {
    const rp = await openPage(browser, url, { reduce: true, ua });
    await rp.goto(url, { waitUntil: "domcontentloaded", timeout: 12000 }).catch(() => {});
    await rp.waitForNetworkIdle({ idleTime: 500, timeout: 4000 }).catch(() => {});
    await rp.evaluate(() => { if (window.__hm) window.__hm.phase = "overlay"; }).catch(() => {});
    await clearOverlays(rp);
    await rp.evaluate(() => { if (window.__hm) window.__hm.phase = "load"; }).catch(() => {});
    await wait(1200);
    await scrollThrough(browser, rp, width, height, { frames: false, steps: 4, settle: 350 });
    const r2 = await rp.evaluate(() => window.__hm?.collect()).catch(() => null);
    await rp.close().catch(() => {});
    if (r2) {
      const full = all.filter((a) => a.iterations !== "infinite").length;
      const kept = [...r2.anims, ...r2.js].filter((a) => a.iterations !== "infinite" && a.phase !== "overlay");
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
      v: 1, measured_at: new Date().toISOString(), width, overlays,
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
  // #77: contrast of each text element against what is behind it, composited up through its ancestors' backgrounds.
  // Text over a background image or gradient is counted apart: its contrast can't be read from styles.
  const rgba = (c) => {
    const m = String(c).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const v = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return v.length >= 3 && v.slice(0, 3).every(Number.isFinite) ? [v[0], v[1], v[2], Number.isFinite(v[3]) ? v[3] : 1] : null;
  };
  const over = (top, under) => {
    const a = top[3];
    return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)).concat(1);
  };
  const lum = (c) => {
    const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const bgMemo = new WeakMap();
  const behind = (el) => {
    if (bgMemo.has(el)) return bgMemo.get(el);
    const layers = [];
    let image = false;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const st = getComputedStyle(e);
      if (st.backgroundImage && st.backgroundImage !== "none") { image = true; break; }
      const c = rgba(st.backgroundColor);
      if (c && c[3] > 0) { layers.push(c); if (c[3] >= 0.99) break; }
    }
    let base = [255, 255, 255, 1];
    for (const c of layers.reverse()) base = over(c, base);
    const out = { bg: base, image };
    bgMemo.set(el, out);
    return out;
  };
  const hex = (c) => "#" + c.slice(0, 3).map((x) => Math.round(x).toString(16).padStart(2, "0")).join("");
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
        sample: t.replace(/\s+/g, " ").slice(0, 40), colour: s.color, c_min: null, c_pair: null, c_below: 0, c_image: 0, c_large: false, c_text: null };
      treatments.set(key, tr);
    }
    tr.uses++; tr.chars += t.length; total += t.length;
    const fg = rgba(s.color), bk = behind(el);
    if (fg && bk.image) tr.c_image++;
    else if (fg) {
      const f = fg[3] < 1 ? over(fg, bk.bg) : fg;
      const L1 = lum(f), L2 = lum(bk.bg);
      const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      // WCAG AA: 4.5:1, or 3:1 for large text (24 px, or 18.66 px bold).
      const large = size >= 24 || (size >= 18.66 && (Number(s.fontWeight) || 400) >= 700);
      if (ratio < (large ? 3 : 4.5)) tr.c_below++;
      if (tr.c_min == null || ratio < tr.c_min) { tr.c_min = ratio; tr.c_pair = [hex(f), hex(bk.bg)]; tr.c_large = large; tr.c_text = t.replace(/\s+/g, " ").slice(0, 40); }
    }
    let role = roleOf(el);
    if (upper && !/^h\d$/.test(role)) role += " (uppercase)";
    tr.roles[role] = (tr.roles[role] ?? 0) + 1;
  }
  const list = [...treatments.values()].filter((t) => t.chars >= 2);
  const body = list.filter((t) => !t.uppercase).sort((a, b) => b.chars - a.chars)[0];
  const sizes = [...new Set(list.map((t) => t.size_px))].sort((a, b) => b - a);
  const contrastOf = (t) => t.c_min == null && !t.c_image ? undefined : {
    lowest: t.c_min == null ? null : Math.round(t.c_min * 100) / 100, colours: t.c_pair ?? undefined, lowest_on: t.c_text ?? undefined,
    needs: t.c_large ? 3 : 4.5, below_aa: t.c_below, over_image: t.c_image || undefined };
  const out = list.sort((a, b) => b.size_px - a.size_px || b.chars - a.chars).slice(0, 24).map(({ c_min, c_pair, c_below, c_image, c_large, c_text, ...t }) => ({
    ...t, roles: Object.entries(t.roles).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([role, uses]) => ({ role, uses })),
    share: total ? Math.round((t.chars / total) * 1000) / 10 : 0,
    contrast: contrastOf({ c_min, c_pair, c_below, c_image, c_large, c_text }),
  }));
  const failing = list.filter((t) => t.c_below > 0);
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
    contrast_summary: {
      treatments_below_aa: failing.length, text_elements_below_aa: failing.reduce((n, t) => n + t.c_below, 0),
      worst: failing.sort((a, b) => a.c_min - b.c_min).slice(0, 3).map((t) => ({ sample: t.c_text ?? t.sample, size_px: t.size_px,
        ratio: Math.round(t.c_min * 100) / 100, colours: t.c_pair })),
      over_image: list.reduce((n, t) => n + t.c_image, 0),
    },
  };
}

// #77: facts, not opinions, from the rendered page at this viewport. Headings in order and where the order breaks,
// calls to action in the first screen, and (on a phone) tap targets under 44 x 44 px (Apple's and Material's minimum
// is 44 and 48; WCAG 2.2's floor is 24).
function pageFacts() {
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && parseFloat(s.opacity) > 0.05;
  };
  const words = (el) => (el.innerText || el.getAttribute("aria-label") || el.value || el.title || el.querySelector?.("img[alt]")?.alt || "")
    .trim().replace(/\s+/g, " ").slice(0, 50);
  // Headings, h1 to h6 and role=heading, in document order.
  const heads = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role='heading'][aria-level]")].filter(shown).map((h) => ({
    level: /^H\d$/.test(h.tagName) ? Number(h.tagName[1]) : Number(h.getAttribute("aria-level")) || 2, text: words(h),
    top: Math.round(h.getBoundingClientRect().top + scrollY) }));
  const breaks = [];
  heads.forEach((h, i) => {
    const prev = heads[i - 1];
    if (prev && h.level > prev.level + 1) breaks.push({ from: `h${prev.level}`, to: `h${h.level}`, text: h.text, top: h.top });
  });
  // Calls to action in the first screen: buttons, and links styled as buttons (their own fill or border, and padding).
  const vh = innerHeight;
  const ctaLike = (el) => {
    if (el.matches("button, [role='button'], input[type='submit'], input[type='button']")) return true;
    const s = getComputedStyle(el);
    const fill = (s.backgroundColor.match(/rgba?\(([^)]+)\)/)?.[1].split(/[ ,/]+/).map(Number) ?? [0, 0, 0, 0]);
    const filled = fill.length > 3 ? fill[3] > 0.1 : fill.length === 3;
    const bordered = parseFloat(s.borderTopWidth) >= 1 && s.borderTopStyle !== "none" && parseFloat(s.borderBottomWidth) >= 1;
    return (filled || bordered) && parseFloat(s.paddingLeft) >= 8 && parseFloat(s.paddingTop) >= 4;
  };
  // The site's own header and navigation, not a page hero that happens to sit in a <header> (Oak's does).
  const inChrome = (el) => {
    if (el.closest("nav, [role='navigation']")) return true;
    const h = el.closest("header, [role='banner']");
    return !!h && h.getBoundingClientRect().height < 200;
  };
  const ctas = [], seen = new Set();
  for (const el of document.querySelectorAll("a[href], button, [role='button'], input[type='submit'], input[type='button']")) {
    if (seen.has(el) || !shown(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.top + scrollY >= vh || r.bottom + scrollY <= 0) continue;
    if (!ctaLike(el)) continue;
    const t = words(el);
    if (!t || /^skip to/i.test(t)) continue;
    seen.add(el);
    ctas.push({ text: t, in_header: inChrome(el) || undefined, size: `${Math.round(r.width)}x${Math.round(r.height)}` });
  }
  const out = {
    viewport: `${innerWidth}x${innerHeight}`,
    headings: { count: heads.length, h1: heads.filter((h) => h.level === 1).length, first: heads[0] ? `h${heads[0].level}` : null,
      order_breaks: breaks.slice(0, 10), outline: heads.slice(0, 40).map((h) => `h${h.level} ${h.text}`) },
    ctas_above_fold: { count: ctas.length, outside_header: ctas.filter((c) => !c.in_header).length, list: ctas.slice(0, 12) },
  };
  // Tap targets, on a phone only: every link, button and form control a thumb would hit.
  if (innerWidth < 600) {
    const small = [];
    let total = 0;
    for (const el of document.querySelectorAll("a[href], button, [role='button'], input:not([type='hidden']), select, textarea, summary, label[for]")) {
      if (!shown(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      // A link inside running text is exempt in WCAG; count it apart.
      const inline = el.tagName === "A" && getComputedStyle(el).display === "inline" && el.parentElement?.closest("p, li") && (el.parentElement.innerText || "").length > (el.innerText || "").length + 20;
      if (inline) continue;
      total++;
      if (r.width < 44 || r.height < 44) small.push({ text: words(el) || el.tagName.toLowerCase(), size: `${Math.round(r.width)}x${Math.round(r.height)}`,
        under_24: r.width < 24 || r.height < 24 || undefined, top: Math.round(r.top + scrollY) });
    }
    out.tap_targets = { checked: total, under_44: small.length, under_24: small.filter((x) => x.under_24).length,
      smallest: small.sort((a, b) => { const ar = (x) => x.size.split("x").map(Number).reduce((p, q) => Math.min(p, q)); return ar(a) - ar(b); }).slice(0, 10) };
  }
  return out;
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
    const overlays = await clearOverlays(page);
    await page.evaluate(() => document.fonts?.ready).catch(() => {});
    // Scroll through first, so text that only appears on scroll (reveals, lazy sections) is counted.
    await page.evaluate(async () => {
      const step = Math.max(400, Math.floor(window.innerHeight * 0.8));
      const end = Math.min(document.documentElement.scrollHeight, 12000);
      for (let y = 0; y < end; y += step) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 150)); }
      window.scrollTo(0, 0);
    }).catch(() => {});
    await wait(500);
    const type = await page.evaluate(typeAndIcons);
    type.facts = await page.evaluate(pageFacts).catch((e) => ({ error: String(e?.message ?? e).slice(0, 120) }));
    type.overlays = overlays;
    return type;
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
  return { type_scale: { v: 2, measured_at: new Date().toISOString(), at_1440: desktop, at_390: phone } };
}

// #79: the whole page as tiles at native width, one per section, so a tall page stays legible (Oak at 4,683 px came
// back as one image at 615 x 2000; Stripe at 15,000 px would be unreadable). Sections are found from the page's own
// blocks (header, sections, footer, the top-level children of its main wrapper); small ones are grouped and tall
// ones split, so each tile is between TILE_MIN and TILE_MAX px tall. Each tile is stitched from screen-sized frames,
// like the whole-page shot, and returned as JPEG. A response stops at TILE_BYTES (Vercel's response limit is 4.5 MB)
// or at 45 seconds and says where to carry on: call again with { from: next_from }.
const TILE_MIN = 600, TILE_MAX = 2400, TILE_PAGE_MAX = 30000, TILE_BYTES = 2_600_000;

// Runs in the page: the tops of its sections, with the first heading in each.
function sectionTops() {
  const vw = innerWidth;
  const H = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
  const absTop = (el) => Math.round(el.getBoundingClientRect().top + scrollY);
  const wide = (el) => { const r = el.getBoundingClientRect(); return r.width >= vw * 0.6 && r.height >= 120; };
  // Walk down through single wrappers (#__next > div > main ...) to the level where the page splits into blocks.
  let node = document.body;
  for (let i = 0; i < 8; i++) {
    const kids = [...node.children].filter((k) => wide(k) && getComputedStyle(k).position !== "fixed");
    if (kids.length === 1) node = kids[0]; else break;
  }
  const cands = new Set([...node.children, ...document.querySelectorAll("header, footer, section, main > *, [class*='section' i]")]);
  const tops = [];
  for (const el of cands) {
    if (!(el instanceof Element) || !wide(el)) continue;
    const s = getComputedStyle(el);
    if (s.position === "fixed" || s.display === "none" || s.visibility === "hidden") continue;
    const h = el.querySelector("h1, h2, h3");
    tops.push({ top: absTop(el), label: (h?.innerText || el.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 60) || null });
  }
  return { tops: tops.sort((a, b) => a.top - b.top), height: H };
}

// Cut points from section tops: each tile ends at the last section top that keeps it under TILE_MAX, at least
// TILE_MIN below where it starts; with none, it is cut at TILE_MAX. A short remainder joins the tile before it.
export function planTiles(tops, H) {
  const pts = [...new Set(tops.map((t) => t.top).filter((y) => y > 0 && y < H))].sort((a, b) => a - b);
  const label = (y0, y1) => tops.find((t) => t.top >= y0 && t.top < y1 && t.label)?.label ?? null;
  const tiles = [];
  let start = 0;
  while (start < H) {
    let end = Math.min(H, start + TILE_MAX);
    if (end < H) {
      const fits = pts.filter((y) => y >= start + TILE_MIN && y <= start + TILE_MAX);
      if (fits.length) end = fits[fits.length - 1];
      if (H - end < TILE_MIN / 2 && H - start <= TILE_MAX + TILE_MIN / 2) end = H;
    }
    tiles.push({ top: start, bottom: end, section: label(start, end) });
    start = end;
  }
  return tiles;
}

export async function measureTiles(browser, url, width, height, ua, from = 0, t0 = Date.now()) {
  const page = await openPage(browser, url, { reduce: true, ua, record: false });
  try {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    const resp = await page.goto(url, { waitUntil: "networkidle2", timeout: 25000 }).catch(() => null);
    if (!resp) await page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 }).catch(() => {});
    const overlays = await clearOverlays(page);
    // Scroll through once so lazy images and reveals load, then read where the sections start.
    await page.evaluate(async (max) => {
      const step = Math.max(400, Math.floor(innerHeight * 0.8));
      for (let y = 0; y < Math.min(document.documentElement.scrollHeight, max); y += step) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 110)); }
      scrollTo(0, 0);
    }, TILE_PAGE_MAX).catch(() => {});
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 }).catch(() => {});
    const { tops, height: fullHeight } = await page.evaluate(sectionTops);
    const H = Math.min(fullHeight, TILE_PAGE_MAX);
    const plan = planTiles(tops, H);
    const hideChrome = () => page.evaluate((vh) => {
      for (const el of document.querySelectorAll("body *")) {
        const s = getComputedStyle(el);
        if ((s.position === "fixed" || s.position === "sticky") && el.getBoundingClientRect().height < vh * 0.4) el.style.setProperty("visibility", "hidden", "important");
      }
    }, height);
    // A fixed or sticky header shows once, at the top of the first tile; later frames hide it, as the whole-page shot does.
    let chromeHidden = false;
    if (from > 0) { await hideChrome(); chromeHidden = true; }
    // All frames first, then the compositing tab: a page in a background tab stops painting, and screenshots of it hang.
    const shots = [];
    let bytes = 0, next = null;
    for (const [i, t] of plan.entries()) {
      if (t.bottom <= from) continue;
      // Frame bytes run close to the finished tile's, so they set the budget.
      if (shots.length && (bytes > TILE_BYTES || Date.now() - t0 > 40000)) { next = t.top; break; }
      const frames = [];
      for (let y = t.top; y < t.bottom; y += height) {
        await page.evaluate((y) => scrollTo(0, y), Math.min(y, Math.max(0, fullHeight - height)));
        await wait(200);
        const real = await page.evaluate(() => Math.round(scrollY));
        const data = (await page.screenshot({ type: "jpeg", quality: 85 })).toString("base64");
        bytes += data.length * 0.75;
        frames.push({ y: real - t.top, data });
        if (!chromeHidden) { await hideChrome(); chromeHidden = true; }
      }
      shots.push({ i, t, frames });
    }
    const out = [];
    const sheet = await browser.newPage();
    try {
      for (const { i, t, frames } of shots) {
        const b64 = await sheet.evaluate(async (frames, W, Ht) => {
          const c = document.createElement("canvas");
          c.width = W; c.height = Ht;
          const g = c.getContext("2d");
          g.fillStyle = "#fff"; g.fillRect(0, 0, W, Ht);
          // Later frames first, so an earlier frame wins any overlap (the last frame of a page is pulled up to fit).
          for (const f of [...frames].reverse()) {
            const im = new Image(); im.src = `data:image/jpeg;base64,${f.data}`; await im.decode();
            g.drawImage(im, 0, f.y);
          }
          return c.toDataURL("image/jpeg", 0.8).split(",")[1];
        }, frames, width, t.bottom - t.top);
        out.push({ index: i + 1, top: t.top, height: t.bottom - t.top, section: t.section, image: b64 });
      }
    } finally {
      await sheet.close().catch(() => {});
    }
    return { tiles: out, total: plan.length, page_height: fullHeight, clipped: fullHeight > TILE_PAGE_MAX, next_from: next, width, overlays,
      status: resp?.status() ?? null };
  } catch (e) {
    return { error: String(e?.message ?? e).slice(0, 200), stage: "tiles" };
  } finally {
    await page.close().catch(() => {});
  }
}
