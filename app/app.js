import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const SUPABASE_URL = "https://hhfjfbuiuhhdhwhfwlpv.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable_GU1FVCM8tIsiGP8Zy_wZOQ_qac1hgnt"; // public by design
const API = `${SUPABASE_URL}/functions/v1/hopper-api`;

const FORMATS = ["note", "list", "quote", "bookmark", "image", "scratch", "reference", "component"];
const COLOURS = ["RED", "ORANGE", "YELLOW", "GREEN", "TEAL", "BLUE", "CERULEAN", "PURPLE", "PINK", "BROWN", "GRAY"];

const sb = createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" },
});

const $ = (id) => document.getElementById(id);
const state = { projects: [], project: null, topic: null, q: "", archived: false, bin: false, binOffset: 0, oldest: null, loading: false, done: false, share: null, note: null, tagOptions: null };

// ---------- helpers ----------
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}
function icon(name) { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); const u = document.createElementNS("http://www.w3.org/2000/svg", "use"); u.setAttribute("href", `#i-${name}`); s.append(u); return s; }
const fmtDate = (d) => new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const fmtTime = (d) => new Date(d).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
// A toast can carry one action button (the "Add note" after a share); it then stays up longer, and a tap on the
// action hides it. ms 0 keeps it up until the next toast.
function toast(msg, action = null, ms = action ? 7000 : 2600) {
  const t = $("toast");
  t.replaceChildren(...[
    el("span", {}, msg),
    action ? el("button", { type: "button", class: "toast-act", onclick: () => { t.hidden = true; action.onclick(); } }, action.label) : null,
  ].filter(Boolean));
  t.hidden = false; clearTimeout(toast.t);
  if (ms) toast.t = setTimeout(() => (t.hidden = true), ms);
}
function autosize(t) { t.style.height = "auto"; t.style.height = `${t.scrollHeight}px`; }
const colourClass = (c) => (c ? `c-${c}` : "");

async function api(body) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) throw new Error("signed out");
  const r = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${session.access_token}`, apikey: PUBLISHABLE_KEY },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) {
    // A 401 is either a dead session (signed out elsewhere, or expired) or a signed-in account that isn't the owner.
    // Ask Auth which: a dead session goes back to the sign-in screen with a plain reason.
    const { error } = await sb.auth.getUser();
    if (error) {
      signinNote = "You were signed out. Sign in again to carry on.";
      await sb.auth.signOut({ scope: "local" });
      throw new Error("signed out");
    }
    throw new Error("This account isn't Hopper's owner.");
  }
  if (!r.ok) throw new Error(j.error || `Error ${r.status}`);
  return j;
}

// ---------- screens ----------
function show(screen) { for (const s of ["signin", "home"]) $(s).hidden = s !== screen; }

let booted = false;
let signinNote = "";
// A sign-in link that failed comes back as ?error=...&error_code=... (or in the hash). Say why, then clear the address.
function linkError() {
  const p = new URLSearchParams(location.search + "&" + location.hash.replace(/^#/, ""));
  const code = p.get("error_code") || p.get("error");
  if (!code) return "";
  history.replaceState({}, "", location.pathname === "/share" ? "/" : location.pathname);
  if (code === "otp_expired") return "That sign-in link has expired or was already used. Each new link cancels the ones before it, so use only the newest.";
  return `That sign-in link didn't work (${p.get("error_description") || code}). Request a new one.`;
}
function signinError(error) {
  if (error.status === 429 || /rate limit/i.test(error.message))
    return "Too many sign-in emails: Supabase sends at most 2 an hour. Try again in an hour, and use the newest link.";
  if (/code verifier/i.test(error.message))
    return "Open the link in the same browser you asked for it from (on Android, copy the link into Chrome).";
  return error.message;
}
const PENDING = "hopper.pendingShare";
async function boot() {
  if (booted) return;
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  readShare();
  const bad = linkError();
  let session = null;
  try {
    const r = await sb.auth.getSession();
    session = r.data.session;
    if (r.error && !bad) signinNote = signinError(r.error);
  } catch (e) { signinNote = signinError(e); }
  if (bad) signinNote = bad;
  if (!session) {
    // Never leave a blank page: both screens start hidden, so always show one.
    $("signin-msg").textContent = signinNote;
    signinNote = "";
    // HOP-9: keep a share through sign-in. The magic link reloads the app, so park the share on this device.
    if (state.share) {
      try { localStorage.setItem(PENDING, JSON.stringify({ ...state.share, at: Date.now() })); } catch {}
      $("signin-msg").textContent = "Your share is kept. Sign in and it will be ready to save.";
    }
    show("signin"); return;
  }
  if (!state.share) {
    try {
      const p = JSON.parse(localStorage.getItem(PENDING) || "null");
      if (p && Date.now() - p.at < 86400000) state.share = { url: p.url || "", text: p.text || "", title: p.title || "", images: p.images || 0 };
    } catch {}
  }
  try { localStorage.removeItem(PENDING); } catch {}
  if (booted) return;
  booted = true;
  show("home");
  try {
    await loadProjects();
    track("open");
    route();
    if (state.share) { state.share.blobs = await sharedImages(state.share.images); saveShare(state.share); }
  } catch (e) { $("status").textContent = e.message; }
}

sb.auth.onAuthStateChange((event) => {
  if (event === "SIGNED_IN") boot();
  if (event === "SIGNED_OUT") { booted = false; $("signin-msg").textContent = signinNote; signinNote = ""; show("signin"); }
});

$("signin-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("email").value.trim();
  // Back to the app's root: a parked share waits in localStorage (HOP-9), and an old ?error= must not ride along.
  const back = location.origin + "/";
  const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: back } });
  $("signin-msg").textContent = error ? signinError(error)
    : "Check your email. Type the code below, or open the link in this browser. Only the newest email works.";
  if (!error) $("code").focus();
});

$("code-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("email").value.trim(), token = $("code").value.replace(/\D/g, "");
  if (!email) { $("signin-msg").textContent = "Type your email above first."; return; }
  const { error } = await sb.auth.verifyOtp({ email, token, type: "email" });
  // Success fires SIGNED_IN, which boots the app.
  if (error) $("signin-msg").textContent = /expired|invalid/i.test(error.message)
    ? "That code has expired or is wrong. Use the code from the newest email." : signinError(error);
});

// ---------- projects and pills ----------
// Silent navigation count (hopper.ui_events): how often Keith switches project, to decide where the pills live.
// Fire and forget: a failed count never interrupts the app.
const device = () => (window.matchMedia("(max-width: 699px)").matches ? "phone" : "desktop");
function track(event, extra = {}) { api({ action: "event", event, device: device(), ...extra }).catch(() => {}); }

async function loadProjects() {
  const { projects } = await api({ action: "projects" });
  state.projects = projects;
  renderPills();
}

// HOP-13: long-press a project pill (right-click on a computer) to pin it. Pinned pills come first, in the order they
// were pinned, with a pin mark; the rest stay in order of recent activity (the order comes from the projects action).
function renderPills() {
  const nav = $("pills"); nav.replaceChildren();
  const pill = (label, id) => el("button", { class: state.project === id ? "on" : "", onclick: () => { if (justPinned()) return; track("pill", { project_id: id }); pickProject(id); } }, label);
  const projectPill = (p) => {
    const b = el("button", { class: [state.project === p.id ? "on" : "", p.pinned ? "pinned" : ""].filter(Boolean).join(" "),
      title: p.pinned ? "Long-press or right-click to unpin" : "Long-press or right-click to pin",
      // A long-press that pinned the project doesn't also open it.
      onclick: () => { if (b.held || justPinned()) { b.held = false; return; } track("pill", { project_id: p.id }); pickProject(p.id); } },
      p.pinned ? icon("pinned") : null, p.name);
    holdToPin(b, p);
    return b;
  };
  nav.append(pill("All", null), ...state.projects.map(projectPill), el("button", { onclick: openProjects }, "All projects →"));
}

// The pills re-render (in a new order) once a pin is saved, so the tap that ends a long-press can land on a different
// pill: no pill opens for a moment after a long-press.
let pinPressAt = 0;
const justPinned = () => Date.now() - pinPressAt < 1200;
function holdToPin(b, p) {
  let timer = null, start = null;
  const cancel = () => { clearTimeout(timer); timer = null; };
  b.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse") return; // a mouse pins with right-click
    b.held = false; start = [e.clientX, e.clientY];
    timer = setTimeout(() => { b.held = true; timer = null; pinPressAt = Date.now(); togglePin(p); }, 550);
  });
  b.addEventListener("pointermove", (e) => { if (timer && Math.hypot(e.clientX - start[0], e.clientY - start[1]) > 8) cancel(); });
  for (const ev of ["pointerup", "pointercancel", "pointerleave"]) b.addEventListener(ev, cancel);
  // Right-click pins instead of opening the browser menu. A touch long-press can also fire contextmenu: pin once.
  b.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (b.held) return;
    if (timer) { cancel(); b.held = true; pinPressAt = Date.now(); } // touch: the browser's own long-press got there first
    togglePin(p);
  });
}

async function togglePin(p) {
  const pinned = !p.pinned;
  try {
    await api({ action: "pin_project", project_id: p.id, pinned });
    toast(pinned ? `Pinned ${p.name}` : `Unpinned ${p.name}`);
    await loadProjects();
  } catch (e) { toast(e.message); }
}

async function pickProject(id) {
  state.project = id; state.topic = null; state.q = ""; $("q").value = "";
  renderPills();
  const sub = $("subpills");
  if (!id) { sub.hidden = true; } else {
    sub.hidden = false; sub.replaceChildren();
    const { topics } = await api({ action: "topics", project_id: id });
    const tp = (label, name) => el("button", { class: state.topic === name ? "on" : "", onclick: () => { track("topic", { project_id: state.project, topic: name }); state.topic = name; pickTopic(); } }, label);
    sub.append(tp("All topics", null), ...topics.map((t) => tp(t.name, t.name)));
  }
  resetFeed();
}
function pickTopic() { for (const b of $("subpills").children) b.classList.toggle("on", b.textContent === (state.topic ?? "All topics")); resetFeed(); }

function openProjects() {
  track("sheet");
  $("menu").hidden = true;
  const g = $("projects-grid"); g.replaceChildren();
  for (const p of state.projects) g.append(el("button", { onclick: () => { track("sheet_pick", { project_id: p.id }); closeOverlay("projects-sheet"); setArchived(false); pickProject(p.id); } }, el("b", {}, p.name), el("span", { class: "muted" }, `${p.notes} notes · ${fmtDate(p.last_activity)}`)));
  $("projects-sheet").hidden = false;
}

// Special views replace the feed: "archived" or "bin" (null for the normal feed).
function setView(view) {
  state.archived = view === "archived";
  state.bin = view === "bin";
  $("view-banner").hidden = !view;
  $("view-title").textContent = view === "archived" ? "Archived" : view === "bin" ? "Bin" : "";
  $("view-empty").hidden = view !== "bin";
  $("pills").hidden = !!view; $("subpills").hidden = !!view || !state.project;
}
function setArchived(on) { setView(on ? "archived" : null); }
function openView(view) { $("menu").hidden = true; state.project = null; state.topic = null; state.q = ""; $("q").value = ""; setView(view); resetFeed(); }
$("archived-btn").addEventListener("click", () => openView("archived"));
$("bin-btn").addEventListener("click", () => openView("bin"));
$("view-exit").addEventListener("click", () => { setView(null); renderPills(); resetFeed(); });
$("view-empty").addEventListener("click", async () => {
  if (!confirm("Erase everything in the Bin now? This can't be undone.")) return;
  try { const { erased } = await api({ action: "empty_bin", all: true }); toast(`Erased ${erased} note${erased === 1 ? "" : "s"}`); resetFeed(); }
  catch (e) { toast(e.message); }
});

// ---------- feed ----------
function card(n) {
  // Cards in the Bin say when they'll be erased.
  const erase = n.erases_at ? el("div", { class: "c-erase" }, `Erased ${fmtDate(n.erases_at)}`) : null;
  if (n.locked) return el("div", { class: "card locked", "data-id": n.id, onclick: () => openNote(n.id) }, "🔒 ", fmtDate(n.created_at), n.title ? el("div", {}, n.title) : null, erase);
  const projects = (n.projects || []).join(" · ");
  // Image cards lead with the picture and one line: the title, or else the note's first line.
  // HOP-36: display_title (from hopper-api) stands in for a missing or file-like title. Text cards with no title at
  // all stay as Keep shows them, led by their text; a file or site name as a title is replaced.
  const line = n.display_title || n.title || (n.excerpt || "").split("\n").find((s) => s.trim()) || "";
  const shownTitle = n.title ? (n.display_title || n.title) : null;
  const text = n.image
    ? (line ? el("div", { class: "c-text one" }, el("p", { class: "c-line" }, line)) : null)
    : ((shownTitle || n.excerpt) ? el("div", { class: "c-text" },
        shownTitle ? el("p", { class: "c-title" }, shownTitle) : null,
        n.excerpt ? el("div", { class: "c-excerpt" }, n.excerpt) : null) : null);
  // Type, site, projects and date live in the hover overlay (desktop only), to fit more on the board.
  // On image cards it covers just the picture, so the caption stays readable.
  const hover = el("div", { class: "hover" },
    (n.format || n.host) ? el("div", { class: "h-type" }, n.format ? el("span", { class: "badge" }, n.format) : null, n.host ? el("span", {}, n.host) : null) : null,
    projects ? el("b", {}, projects) : null,
    el("span", {}, fmtDate(n.created_at)));
  const media = n.image ? el("div", { class: "c-media" },
    el("img", { src: n.image, alt: "", onerror: (e) => { e.target.closest(".card")?.classList.remove("has-media"); e.target.parentNode.replaceWith(hover); } }),
    mediaMark(n.media), hover) : null;
  return el("div", { class: `card ${n.format || ""} ${colourClass(n.color)}${media ? " has-media" : ""}`, "data-id": n.id, onclick: () => openNote(n.id) },
    n.pinned ? (() => { const s = icon("pinned"); s.classList.add("pin-mark"); return s; })() : null,
    media, text, media ? null : hover, erase);
}

// HOP-44: one small icon in the corner of a card's picture saying what the note holds (video, audio, PDF, a set of
// pictures with its count, or a link). hopper-api picks the one by priority.
const MEDIA_LABEL = { video: "Video", audio: "Audio", pdf: "PDF", set: "Pictures", link: "Link" };
function mediaMark(m) {
  if (!m || !MEDIA_LABEL[m.kind]) return null;
  const label = m.kind === "set" ? `${m.count} pictures` : MEDIA_LABEL[m.kind];
  return el("span", { class: `c-kind k-${m.kind}`, title: label, "aria-label": label }, icon(`m-${m.kind}`), m.kind === "set" ? el("b", {}, String(m.count)) : null);
}

// ---------- masonry ----------
// Each card goes into the shortest column once and never moves. (CSS columns re-flowed the whole board whenever a
// batch loaded or an image arrived, so cards jumped between columns while scrolling.) data-seq keeps the
// newest-first order, so a resize that changes the column count can lay the cards out again.
// Full width: as many ~230px columns as fit (2 at least, on phones).
const colCount = () => Math.max(2, Math.floor((document.documentElement.clientWidth - 16) / 230));
function layout(box, cards = []) {
  const n = colCount();
  box.dataset.cols = n; box.seq = 0; box.gen = (box.gen || 0) + 1;
  box.replaceChildren(...Array.from({ length: n }, () => el("div", { class: "col" })));
  place(box, cards);
}
function place(box, cards) {
  if (!box.children.length) layout(box);
  const cols = [...box.children];
  const h = cols.map((c) => c.offsetHeight);
  for (const c of cards) {
    const i = h.indexOf(Math.min(...h));
    c.dataset.seq = box.seq++;
    cols[i].append(c);
    // sizeImages has usually reserved each image's space already; one it couldn't size counts as square.
    const img = c.querySelector(".c-media img");
    h[i] += c.offsetHeight + (img && !img.style.aspectRatio && !img.complete ? c.offsetWidth : 0) + 10;
  }
}
// Wait briefly for each image's size (its header arrives long before the image) and reserve the space with
// aspect-ratio, so every card's real height is known when it is placed and the columns stay even.
function sizeImages(cards, wait = 1500) {
  const imgs = cards.map((c) => c.querySelector(".c-media img")).filter(Boolean);
  return Promise.all(imgs.map((img) => new Promise((done) => {
    const t0 = performance.now();
    (function poll() {
      if (img.naturalWidth) { img.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`; return done(); }
      if (img.complete || performance.now() - t0 > wait) return done();
      setTimeout(poll, 40);
    })();
  })));
}
// Places a batch once its images are sized. Returns false if the board was reset meanwhile (new filter or
// search), so a stale batch never lands in the new board.
async function placeSized(box, cards, gen = box.gen) {
  await sizeImages(cards);
  if (box.gen !== gen) return false;
  place(box, cards);
  return true;
}
const hasCards = (box) => !!box.querySelector(".card");
let resizeTimer;
addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    for (const box of [$("pinned"), $("feed")]) {
      if (Number(box.dataset.cols) === colCount()) continue;
      const cards = [...box.querySelectorAll(":scope > .col > .card")].sort((a, b) => a.dataset.seq - b.dataset.seq);
      layout(box, cards);
    }
  }, 150);
});

async function loadPinned() {
  const wrap = $("pinned-wrap");
  if (state.q || state.archived || state.bin) { wrap.hidden = true; return; }
  try {
    const { notes } = await api({ action: "feed", pinned: true, project_id: state.project, topic: state.topic, limit: 40 });
    const cards = notes.map(card);
    await sizeImages(cards);
    wrap.hidden = notes.length === 0;
    layout($("pinned"), cards);
  } catch { wrap.hidden = true; }
}

function resetFeed() {
  state.oldest = null; state.binOffset = 0; state.done = false; layout($("feed")); $("status").textContent = "";
  window.scrollTo({ top: 0 });
  loadPinned();
  loadMore();
}

async function loadMore() {
  if (state.loading || state.done) return;
  state.loading = true; $("more").textContent = "Loading…";
  const gen = $("feed").gen; // a reset while this batch loads makes it stale
  try {
    if (state.bin) {
      // The Bin loads in pages as you scroll, like the feed.
      const { notes, bin_days, total } = await api({ action: "bin", offset: state.binOffset, limit: 60 });
      if (await placeSized($("feed"), notes.map(card), gen)) {
        state.binOffset += notes.length;
        if (notes.length < 60) state.done = true;
        $("status").textContent = !total ? "The Bin is empty."
          : `${total} note${total === 1 ? "" : "s"} in the Bin. Notes are erased ${bin_days} days after you delete them.`;
      }
    } else if (state.q) {
      const { notes } = await api({ action: "search", q: state.q, device: device() });
      if (await placeSized($("feed"), notes.map(card), gen)) {
        $("status").textContent = notes.length ? `Closest matches for “${state.q}”` : `Nothing close to “${state.q}”`;
        state.done = true;
      }
    } else {
      const { notes } = await api({ action: "feed", project_id: state.project, topic: state.topic, before: state.oldest, archived: state.archived, pinned: state.archived ? undefined : false, limit: 40 });
      if (await placeSized($("feed"), notes.map(card), gen)) {
        if (notes.length) state.oldest = notes[notes.length - 1].created_at;
        if (notes.length < 40) state.done = true;
        if (state.archived && !hasCards($("feed"))) $("status").textContent = "Nothing archived.";
      }
    }
  } catch (e) { if ($("feed").gen === gen) { $("status").textContent = e.message; state.done = true; } }
  state.loading = false; $("more").textContent = "";
  // The observer only fires when "more" crosses into range. If a batch didn't push it back out (a tall screen,
  // short cards), nothing would fire again, so look again: observing afresh reports the current state.
  if (!state.done) { moreObserver.unobserve($("more")); moreObserver.observe($("more")); }
}

const moreObserver = new IntersectionObserver((es) => { if (es[0].isIntersecting) loadMore(); }, { rootMargin: "800px" });
moreObserver.observe($("more"));

let searchTimer;
$("q").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.q = $("q").value.trim(); resetFeed(); }, 450);
});
$("search-form").addEventListener("submit", (e) => { e.preventDefault(); clearTimeout(searchTimer); state.q = $("q").value.trim(); $("q").blur(); resetFeed(); });

// Header hides as you scroll down and comes back as you scroll up.
let lastY = 0;
addEventListener("scroll", () => {
  const y = scrollY;
  $("top").classList.toggle("hide", y > lastY && y > 120);
  lastY = y;
}, { passive: true });

// Replace or remove a card in the lists after an edit, without reloading.
function refreshCard(id, next) {
  for (const old of document.querySelectorAll(`.card[data-id="${id}"]`)) {
    if (!next) { old.remove(); continue; }
    const fresh = card(next);
    if (old.dataset.seq) fresh.dataset.seq = old.dataset.seq;
    old.replaceWith(fresh);
  }
}

// ---------- note editor (with its own address) ----------
let saveTimer = null, pending = {};
function queueSave(fields) {
  Object.assign(pending, fields);
  $("d-meta").textContent = "Saving…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 700);
}
async function flushSave() {
  clearTimeout(saveTimer);
  const n = state.note;
  if (!n || !Object.keys(pending).length) return;
  const fields = pending; pending = {};
  try {
    const { note } = await api({ action: "update", id: n.id, ...fields });
    Object.assign(n, fields);
    $("d-meta").textContent = `Edited ${fmtTime(note.edited_at)}`;
    refreshCard(n.id, cardFromNote(n));
  } catch (e) { $("d-meta").textContent = "Not saved"; toast(e.message); Object.assign(pending, fields); }
}
function cardFromNote(n) {
  const host = n.links?.[0]?.url ? n.links[0].url.replace(/^https?:\/\/(www\.)?/, "").split("/")[0] : null;
  // The display title holds only while the title is as it was when the note opened.
  const display_title = (n.title || "") === (n.title0 ?? "") ? n.display_title ?? null : null;
  return { id: n.id, locked: false, title: n.title, display_title, excerpt: (n.body || n.summary || "").slice(0, 220), format: n.format, created_at: n.created_at,
    image: n.images?.[0]?.url ?? n.links?.[0]?.thumbnail_url ?? null, host, projects: (n.tags || []).filter((t) => t.kind === "project").map((t) => t.name), pinned: n.pinned, color: n.color };
}

function setEditorChrome(n) {
  const sheet = $("d-sheet");
  sheet.className = `sheet tall detail ${colourClass(n?.color)}`;
  // Binned notes are read-only until restored: the Bin banner holds their only actions.
  const locked = !n || n.locked || !!n.deleted_at;
  for (const id of ["d-pin", "d-archive", "d-colour-btn", "d-format", "d-more"]) $(id).hidden = locked;
  $("d-lock").hidden = !n || !!n.deleted_at || (n.locked && !(n.can_unlock ?? n.user_locked));
  if (!n) return;
  $("d-pin").replaceChildren(icon(n.pinned ? "pinned" : "pin"));
  $("d-pin").classList.toggle("on", !!n.pinned);
  $("d-pin").setAttribute("aria-label", n.pinned ? "Unpin" : "Pin");
  $("d-archive").replaceChildren(icon(n.archived ? "unarchive" : "archive"));
  $("d-archive").setAttribute("aria-label", n.archived ? "Unarchive" : "Archive");
  $("d-lock").setAttribute("aria-label", n.locked ? "Unlock" : "Lock");
  $("d-lock").classList.toggle("on", !!n.locked);
  const sel = $("d-format"); sel.replaceChildren(...FORMATS.map((f) => el("option", { value: f, selected: f === (n.format || "note") }, f[0].toUpperCase() + f.slice(1))));
  $("d-meta").textContent = n.edited_at ? `Edited ${fmtDate(n.edited_at)}` : `Saved ${fmtDate(n.created_at)}`;
  $("d-open-link").hidden = !n.links?.length;
}

// HOP-42: a tag chip is a way in. Tapping it closes the note and shows everything else with that tag: a project
// opens its feed, a topic opens within the note's project (or as a search when the note has none), and a person or
// work runs a search. Editing moves behind the pencil: in edit mode chips show confirm and remove, and "+ Tag".
function chipsFor(n) {
  const editing = !!state.tagEdit;
  const wrap = el("div", { class: `chips ${editing ? "editing" : ""}` });
  for (const t of n.tags || []) {
    const unsure = t.confidence === "low" && !t.confirmed;
    // Project tags filed by closeness can be confirmed too; confirming makes the note an anchor for that project.
    const confirmable = unsure || (t.kind === "project" && t.added_by === "rule" && !t.confirmed);
    const why = editing ? (t.near ? `Filed near “${t.near}”` : unsure ? "The AI isn't sure about this one" : "") : `Show everything tagged ${t.name}`;
    const chip = el(editing ? "span" : "button", { class: `chip ${unsure ? "unsure" : ""}`, title: why },
      el("span", { class: "k" }, t.kind), t.name, unsure ? "?" : "",
      editing && t.near ? el("span", { class: "near" }, `near ${t.near}`) : null,
      editing && confirmable ? el("span", { class: "ok", title: "Confirm", onclick: (e) => { e.stopPropagation(); tagOp(t, "confirm"); } }, "✓") : null,
      editing ? el("span", { class: "x", title: "Remove", onclick: (e) => { e.stopPropagation(); tagOp(t, "remove"); } }, "✕") : null);
    if (!editing) chip.addEventListener("click", () => goTag(n, t));
    wrap.append(chip);
  }
  if (editing) wrap.append(el("span", { class: "chip add", onclick: openTagPicker }, "+ Tag"),
    el("button", { class: "chip edit", onclick: () => setTagEdit(false) }, "Done"));
  else wrap.append(el("button", { class: "chip edit", title: "Edit tags", "aria-label": "Edit tags", onclick: () => setTagEdit(true) }, icon("edit")));
  return wrap;
}
function redrawChips() { if (state.note) $("d-chips").replaceWith(Object.assign(chipsFor(state.note), { id: "d-chips" })); }
function setTagEdit(on) { state.tagEdit = on; redrawChips(); }

async function goTag(n, t) {
  const projectOf = (name) => state.projects.find((p) => p.name === name);
  const home = t.kind === "project" ? projectOf(t.name)
    : t.kind === "topic" ? (n.tags || []).filter((x) => x.kind === "project").map((x) => projectOf(x.name)).find(Boolean) : null;
  if (history.state?.note) history.back(); else { await closeDetail(); history.replaceState({}, "", "/"); }
  setView(null);
  if (home) {
    await pickProject(home.id);
    if (t.kind === "topic") { state.topic = t.name; pickTopic(); }
  } else {
    state.project = null; state.topic = null; renderPills(); $("subpills").hidden = true;
    $("q").value = t.name; state.q = t.name; resetFeed();
  }
}

async function tagOp(t, op) {
  const n = state.note;
  try {
    await api({ action: "tag", id: n.id, kind: t.kind, name: t.name, op });
    if (op === "remove") n.tags = n.tags.filter((x) => !(x.kind === t.kind && x.name === t.name));
    if (op === "confirm") { t.confirmed = true; t.confidence = "high"; }
    redrawChips();
    refreshCard(n.id, cardFromNote(n));
  } catch (e) { toast(e.message); }
}

async function openTagPicker() {
  if (!state.tagOptions) state.tagOptions = await api({ action: "tag_options" });
  $("tag-filter").value = "";
  renderTagList("");
  $("tag-sheet").hidden = false;
  setTimeout(() => $("tag-filter").focus(), 50);
}
function renderTagList(q) {
  const n = state.note, have = new Set((n.tags || []).map((t) => `${t.kind}:${t.name}`));
  const match = (s) => s.toLowerCase().includes(q.toLowerCase());
  const list = $("tag-list"); list.replaceChildren();
  for (const [kind, label, names] of [["project", "Projects", state.tagOptions.projects], ["topic", "Topics", state.tagOptions.topics]]) {
    const items = names.filter((x) => match(x) && !have.has(`${kind}:${x}`));
    if (!items.length) continue;
    list.append(el("div", { class: "group" }, label), ...items.map((name) => el("button", { onclick: () => addTag(kind, name) }, name)));
  }
}
$("tag-filter").addEventListener("input", () => renderTagList($("tag-filter").value));
async function addTag(kind, name) {
  const n = state.note;
  try {
    await api({ action: "tag", id: n.id, kind, name, op: "add" });
    n.tags = [...(n.tags || []), { kind, name, confidence: "high", confirmed: true }];
    redrawChips();
    closeOverlay("tag-sheet");
    refreshCard(n.id, cardFromNote(n));
  } catch (e) { toast(e.message); }
}

// What Hopper fetched from a note's link, set apart from Keith's own note:
// a player for YouTube and Vimeo, otherwise the page's picture; then its title, site and description.
// A long address as a reader needs it: the site and the start of the path, no query string. The full address stays
// on the link itself (tap to open, long-press to copy) and in its tooltip.
function shortUrl(u, max = 48) {
  try {
    const x = new URL(u), path = x.pathname.replace(/\/+$/, "");
    const s = x.hostname.replace(/^www\./, "") + (path && path !== "/" ? path : "");
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  } catch { return u.length > max ? u.slice(0, max - 1) + "…" : u; }
}

const VIDEO = [
  [/^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/i, (id) => `https://www.youtube-nocookie.com/embed/${id}`],
  [/^https?:\/\/(?:www\.)?vimeo\.com\/(\d+)/i, (id) => `https://player.vimeo.com/video/${id}`],
];
// Design notes (HOP-20): the design read of images judged design references. Palette swatches (tap to copy the hex),
// the note's aesthetic tags and "how to borrow this" up front; type, layout and techniques folded away.
const HEX = /^#[0-9a-f]{6}$/i;
async function copyHex(hex, name) {
  const label = name ? `${name} (${hex})` : hex;
  try { await navigator.clipboard.writeText(hex); toast(`Copied ${label}`); } catch { toast(label); }
}

// The palette as one strip across the container, each colour as wide as the share of the image it covers.
// Names and roles show on hover or focus, not by default; a click or tap copies the hex.
function paletteStrip(palette) {
  const cols = palette.filter((p) => HEX.test(p.hex));
  if (!cols.length) return null;
  const hasShare = cols.every((p) => p.share > 0);
  const sorted = hasShare ? [...cols].sort((a, b) => b.share - a.share) : cols;
  const total = hasShare ? sorted.reduce((t, p) => t + p.share, 0) : sorted.length;
  const label = el("p", { class: "strip-label", "aria-live": "polite" });
  const describe = (p) => [p.name, p.role, hasShare ? `about ${Math.max(1, Math.round(p.share))}% of the image` : null].filter(Boolean).join(" · ");
  const strip = el("div", { class: "palette-strip", onmouseleave: () => (label.textContent = "") },
    sorted.map((p) => {
      const b = el("button", { type: "button", class: "strip-sw", style: `background:${p.hex};flex-grow:${hasShare ? p.share / total : 1}`,
        "aria-label": `${describe(p)}. Copy ${p.hex}`, onclick: () => { label.textContent = describe(p); copyHex(p.hex, p.name); } });
      b.addEventListener("mouseenter", () => (label.textContent = describe(p)));
      b.addEventListener("focus", () => (label.textContent = describe(p)));
      return b;
    }));
  return el("div", { class: "palette" }, strip, label);
}
// Images saved on their own (not screenshots or figures of a captured page). Captured pages get their own sections.
const SHOT_ROLES = ["first-screen-1440", "first-screen-390", "full-page", "motion-strip"];
const standalone = (n) => (n.images || []).filter((i) => !i.page || !(n.links || []).some((l) => l.url === i.page));
// A note with captured pages leads with the pages; images saved before the capture follow them, compact, as figures do.
const hasPages = (n) => (n.links || []).some((l) => l.page_read) || (n.images || []).some((i) => SHOT_ROLES.includes(i.role));
const topImages = (n) => (hasPages(n) ? [] : standalone(n).filter((i) => i.url));

function otherImages(n) {
  if (!hasPages(n)) return null;
  const imgs = standalone(n).filter((i) => i.url);
  if (!imgs.length) return null;
  return el("details", { class: "dn-more pg-figs other-images" },
    el("summary", {}, `Other images on this note (${imgs.length})`),
    imgs.map((f) => el("div", { class: "pg-fig" },
      el("a", { href: f.url, target: "_blank", rel: "noopener" }, el("img", { src: f.url, alt: f.caption || "", loading: "lazy" })),
      el("div", {},
        f.design?.summary ? el("p", {}, f.design.summary) : null,
        f.design?.moves?.length ? el("div", { class: "chips" }, f.design.moves.map((m) => el("span", { class: "chip" }, m))) : null,
        n.deleted_at ? null : imageActions(n, f)))));
}

// HOP-54: Keith's own pictures on a note (not page screenshots or figures) each have Replace and Remove; removing
// happens at once. "Add image" appears below them while the note has room (four at most).
const ownImages = (n) => (n.images || []).filter((i) => i.id && !i.role && !i.page);
function imageBlock(n) {
  const imgs = topImages(n), editable = !n.deleted_at && !n.locked;
  const room = editable && ownImages(n).length < MAX_IMAGES && !hasPages(n);
  if (!imgs.length) return null;
  return el("div", { class: "d-images" },
    imgs.map((i) => el("figure", { class: "d-img" }, el("img", { src: i.url, alt: i.caption || "" }), editable ? imageActions(n, i) : null)),
    room && imgs.length ? el("div", { class: "img-acts" }, pickButton("Add image", true, async (pics) => {
      await api({ action: "add_images", id: n.id, images: await Promise.all(pics.slice(0, MAX_IMAGES - ownImages(n).length).map(shrink)) });
      return pics.length > 1 ? "Images added" : "Image added";
    })) : null);
}
function imageActions(n, i) {
  if (!i.id || i.role || i.page) return null;
  const remove = el("button", { type: "button", class: "p-act" }, "Remove");
  remove.addEventListener("click", async () => {
    remove.disabled = true; remove.textContent = "Removing…";
    try { await api({ action: "remove_image", id: n.id, image_id: i.id }); toast("Image removed"); return openNote(n.id, false); }
    catch (err) { toast(err.message); remove.disabled = false; remove.textContent = "Remove"; }
  });
  return el("div", { class: "img-acts" },
    pickButton("Replace", false, async ([pic]) => { await api({ action: "replace_image", id: n.id, image_id: i.id, image: await shrink(pic) }); return "Image replaced"; }),
    remove);
}
// A text button that opens the file picker and hands the chosen images to act, then reopens the note.
function pickButton(label, multiple, act) {
  const file = el("input", { type: "file", accept: "image/*", multiple, hidden: true });
  const b = el("button", { type: "button", class: "p-act", onclick: () => file.click() }, label);
  file.addEventListener("change", async () => {
    const pics = [...file.files].filter((f) => f.type.startsWith("image/"));
    file.value = "";
    if (!pics.length) return;
    b.disabled = true; b.textContent = "Saving…";
    try { toast(await act(pics)); return openNote(state.note.id, false); }
    catch (err) { toast(err.message); b.disabled = false; b.textContent = label; }
  });
  return el("span", {}, b, file);
}

function designNotes(n) {
  const reads = hasPages(n) ? [] : standalone(n).map((i) => i.design).filter((d) => d && !d.light);
  if (!reads.length) return null;
  const row = (label, value) => {
    const v = Array.isArray(value) ? value.filter(Boolean).join(", ") : value;
    return v ? el("div", { class: "dn-row" }, el("dt", {}, label), el("dd", {}, v)) : null;
  };
  return el("section", { class: "design-notes" },
    el("h3", {}, "Design notes"),
    reads.map((d, i) => el("div", { class: "dn-read" },
      reads.length > 1 ? el("p", { class: "dn-label" }, `Image ${i + 1}`) : null,
      d.summary ? el("p", { class: "dn-summary" }, d.summary) : null,
      // The note's aesthetic tags sit under the first description.
      i === 0 && n.aesthetics?.length ? el("div", { class: "chips" }, n.aesthetics.map((a) => el("span", { class: "chip" }, a))) : null,
      d.palette.length ? paletteStrip(d.palette) : null,
      d.borrow ? el("div", { class: "borrow" }, el("p", { class: "borrow-k" }, "How to borrow this"), el("p", {}, d.borrow)) : null,
      el("details", { class: "dn-more" },
        el("summary", {}, "Type, layout and techniques"),
        el("dl", {},
          row("Type", [d.type.join(", "), d.families.length ? `possibly ${d.families.join(", ")}` : null]),
          row("Hierarchy", d.type_notes),
          row("Layout", d.layout),
          row("Density", d.density && d.density !== "n/a" ? d.density : null),
          row("Colour", d.colour_notes),
          row("Components", d.components),
          row("Techniques", d.techniques),
          row("Mood", [d.mood.join(", "), d.era]),
          row("Good for", d.good_for),
          row("Kind", d.kind))))));
}

// A captured page (portfolio case study and the like), one section each: the page link, the desktop and phone first
// screens as small thumbnails, the whole page as one continuous image in a scroll box (its slices stacked edge to
// edge), then the page read, and the page's figures folded away with where each sits on the page.
const pathOf = (u) => { try { const x = new URL(u); return (x.hostname.replace(/^www\./, "") + x.pathname).replace(/\/$/, ""); } catch { return u; } };
const px = (v) => `${Number(v).toLocaleString("en-GB")} px`;

function pageRead(r) {
  if (!r) return el("p", { class: "muted pg-pending" }, "Page read on its way: Hopper reads captured pages in the background.");
  const row = (label, value) => {
    const v = Array.isArray(value) ? value.filter(Boolean).join(", ") : value;
    return v ? el("div", { class: "dn-row" }, el("dt", {}, label), el("dd", {}, v)) : null;
  };
  const list = (label, items) => items?.length ? el("div", { class: "pg-list" }, el("p", { class: "dn-label" }, label),
    el("ul", {}, items.map((t) => el("li", {}, t)))) : null;
  const fs = r.first_screen || {};
  return el("div", { class: "pg-read" },
    r.summary ? el("p", { class: "dn-summary" }, r.summary) : null,
    r.moves?.length ? el("div", { class: "chips" }, r.moves.map((m) => el("span", { class: "chip" }, m))) : null,
    r.palette?.length ? paletteStrip(r.palette) : null,
    fs.shows ? el("div", { class: "pg-first" }, el("p", { class: "dn-label" },
      `First screen${Number.isFinite(fs.real_work_pct) ? ` · about ${fs.real_work_pct}% real work` : ""}`), el("p", {}, fs.shows),
      fs.promise ? el("p", { class: "muted" }, fs.promise) : null) : null,
    list("What works", r.strengths),
    list("What holds it back", r.gaps),
    r.borrow ? el("div", { class: "borrow" }, el("p", { class: "borrow-k" }, "How to borrow this"), el("p", {}, r.borrow)) : null,
    el("details", { class: "dn-more" },
      el("summary", {}, "Structure, width, images and type"),
      el("dl", {},
        row("Structure", r.structure),
        row("Width", r.width_use),
        row("Images", r.image_treatment ? `${r.image_treatment.consistent ? "One treatment throughout. " : "Treatment changes. "}${r.image_treatment.description || ""}` : null),
        row("Type and colour", r.type_and_colour),
        row("On a phone", r.phone),
        row("Moves", r.move_notes),
        row("Motion", r.motion))));
}

function capturedPages(n) {
  const imgs = (n.images || []).filter((i) => i.url && i.page);
  return (n.links || []).map((l) => {
    const mine = imgs.filter((i) => i.page === l.url);
    const shots = mine.filter((i) => SHOT_ROLES.includes(i.role));
    if (!shots.length && !l.page_read) return null;
    const byTop = (a, b) => (a.top ?? 0) - (b.top ?? 0);
    const first = shots.find((i) => i.role === "first-screen-1440");
    const phone = shots.find((i) => i.role === "first-screen-390");
    const whole = shots.filter((i) => i.role === "full-page").sort(byTop);
    const motion = shots.filter((i) => i.role === "motion-strip").sort(byTop);
    const figures = mine.filter((i) => i.role === "figure").sort(byTop);
    const thumb = (i, label, cls) => i ? el("a", { class: `pg-thumb ${cls}`, href: i.url, target: "_blank", rel: "noopener" },
      el("img", { src: i.url, alt: label, loading: "lazy" }), el("span", {}, label)) : null;
    return el("section", { class: "captured-page" },
      el("div", { class: "pg-head" },
        el("span", { class: "pg-kicker" }, "Captured page"),
        el("a", { class: "p-link", href: l.url, target: "_blank", rel: "noopener noreferrer" }, l.page_title && !/^https?:/.test(l.page_title) ? l.page_title : pathOf(l.url), " ↗"),
        el("span", { class: "p-host" }, [pathOf(l.url), l.page_height_px_at_1440 ? `${px(l.page_height_px_at_1440)} tall` : null,
          l.videos_on_page ? `${l.videos_on_page} video${l.videos_on_page === 1 ? "" : "s"}` : null,
          l.captured_on ? `captured ${fmtDate(l.captured_on)}` : null].filter(Boolean).join(" · "))),
      (first || phone) ? el("div", { class: "pg-thumbs" }, thumb(first, "Desktop, first screen", "desk"), thumb(phone, "Phone, first screen", "phone")) : null,
      ...motion.map((m) => el("figure", { class: "pg-motion" },
        el("a", { href: m.url, target: "_blank", rel: "noopener" }, el("img", { src: m.url, alt: "", loading: "lazy" })),
        el("figcaption", {}, `Motion: ${m.caption || "three frames, a second apart, left to right"}`))),
      whole.length ? el("div", { class: "pg-whole", tabindex: "0", "aria-label": "Whole page, scroll to read" },
        whole.map((i) => el("img", { src: i.url, alt: "", loading: "lazy" }))) : null,
      whole.length ? el("p", { class: "pg-note" }, "Whole page. Scroll inside the frame to move down it.") : null,
      pageRead(l.page_read),
      figures.length ? el("details", { class: "dn-more pg-figs" },
        el("summary", {}, `Figures from this page (${figures.length})`),
        figures.map((f, k) => el("div", { class: "pg-fig" },
          el("a", { href: f.url, target: "_blank", rel: "noopener" }, el("img", { src: f.url, alt: f.caption || "", loading: "lazy" })),
          el("div", {},
            el("p", { class: "dn-label" }, [`Figure ${k + 1}`, f.top != null ? `${px(f.top)} down` : null,
              f.width_at_1440 ? `${f.width_at_1440} px wide` : null].filter(Boolean).join(" · ")),
            f.design?.summary ? el("p", {}, f.design.summary) : null,
            f.caption_on_page ? el("p", { class: "muted" }, `Caption: ${f.caption_on_page}`) : null,
            f.design?.moves?.length ? el("div", { class: "chips" }, f.design.moves.map((m) => el("span", { class: "chip" }, m))) : null)))) : null);
  }).filter(Boolean);
}

// HOP-61: what a saved video says, from its transcript (hopper-transcript's summary: a paragraph, then "- " points).
function videoSummary(l) {
  if (!l?.transcript_summary) return null;
  const [lead, ...rest] = String(l.transcript_summary).split(/\n\s*\n/);
  const points = rest.join("\n").split("\n").map((x) => x.replace(/^\s*-\s*/, "").trim()).filter(Boolean);
  return el("div", { class: "v-summary" },
    el("p", { class: "dn-label" }, "What the video says"),
    el("p", {}, lead.trim()),
    points.length ? el("ul", {}, points.map((x) => el("li", {}, x))) : null);
}

// HOP-50: when Hopper couldn't read a page (the site blocked it, even in a real browser) and has nothing from it, a quiet
// line says so, with Retry and Add screenshot. Feed cards show nothing.
const UNREAD = ["blocked", "error", "timeout"];
function unreadPage(n, l, desc) {
  if (!UNREAD.includes(l.fetch_status) || desc || n.images?.length || n.locked || n.deleted_at) return null;
  const file = el("input", { type: "file", accept: "image/*", multiple: true, hidden: true });
  const retry = el("button", { type: "button", class: "p-act" }, "Retry");
  const add = el("button", { type: "button", class: "p-act" }, "Add screenshot");
  retry.addEventListener("click", async () => {
    retry.disabled = add.disabled = true; retry.textContent = "Trying…";
    try {
      const r = await api({ action: "refetch", id: n.id });
      toast(r?.ok ? "Read the page" : "Still couldn't read it");
      if (r?.ok) return openNote(n.id, false);
    } catch (err) { toast(err.message); }
    retry.disabled = add.disabled = false; retry.textContent = "Retry";
  });
  add.addEventListener("click", () => file.click());
  file.addEventListener("change", async () => {
    const pics = [...file.files].filter((f) => f.type.startsWith("image/")).slice(0, MAX_IMAGES);
    file.value = "";
    if (!pics.length) return;
    retry.disabled = add.disabled = true; add.textContent = "Adding…";
    try {
      await api({ action: "add_images", id: n.id, images: await Promise.all(pics.map(shrink)) });
      toast("Screenshot added");
      return openNote(n.id, false);
    } catch (err) { toast(err.message); }
    retry.disabled = add.disabled = false; add.textContent = "Add screenshot";
  });
  return el("div", { class: "p-unread" }, el("span", {}, "Couldn't read this page."), retry, add, file);
}

function fromPage(n) {
  const l = n.links?.[0];
  if (!l) return null;
  const host = l.url.replace(/^https?:\/\/(www\.)?/, "").split("/")[0];
  let media = null;
  for (const [re, src] of VIDEO) {
    const m = l.url.match(re);
    if (m) {
      media = el("div", { class: "embed" }, el("iframe", { src: src(m[1]), title: l.page_title || "Video", loading: "lazy",
        allow: "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share",
        allowfullscreen: true, referrerpolicy: "strict-origin-when-cross-origin" }));
      break;
    }
  }
  if (!media && l.thumbnail_url && !n.images?.length) {
    media = el("a", { href: l.url, target: "_blank", rel: "noopener noreferrer" },
      el("img", { src: l.thumbnail_url, alt: l.page_title || "", referrerpolicy: "no-referrer" }));
  }
  const desc = l.page_text || (!n.body && n.format === "bookmark" ? n.summary : null);
  // A note can link the same video twice (a share link and the full address): show its summary once.
  const shown = new Set();
  const summaryOnce = (x) => {
    if (!x.transcript_summary || shown.has(x.transcript_summary)) return null;
    shown.add(x.transcript_summary);
    return videoSummary(x);
  };
  return el("section", { class: "from-page" },
    el("div", { class: "divider" }, "From the page"),
    media,
    el("a", { class: "p-link", href: l.url, title: l.url, target: "_blank", rel: "noopener noreferrer" }, l.page_title || shortUrl(l.url), " ↗"),
    el("span", { class: "p-host" }, host),
    desc ? el("p", { class: "p-desc" }, String(desc).slice(0, 600)) : null,
    unreadPage(n, l, desc),
    summaryOnce(l),
    ...n.links.slice(1).flatMap((x) => [el("a", { class: "p-link", href: x.url, title: x.url, target: "_blank", rel: "noopener noreferrer" }, x.page_title || shortUrl(x.url), " ↗"),
      summaryOnce(x)]));
}

async function openNote(id, push = true) {
  if (push) { history.pushState({ note: id }, "", `/n/${id}`); track("note_open", { note_id: id }); } // HOP-63: a tap on a card
  state.note = null; pending = {};
  const body = $("d-body"); body.replaceChildren(el("p", { class: "muted" }, "Loading…"));
  setEditorChrome(null); $("d-meta").textContent = "";
  $("d-colours").hidden = true; $("d-menu").hidden = true;
  $("d-sheet").style.transform = ""; $("d-sheet").style.transition = ""; $("detail").style.backgroundColor = "";
  $("detail").hidden = false; document.body.style.overflow = "hidden";
  try {
    const { note: n, related } = await api({ action: "note", id });
    state.note = n; state.tagEdit = false; n.title0 = n.title || "";
    setEditorChrome(n);
    const binBar = n.deleted_at ? binBanner(n) : null;
    if (n.locked) {
      body.replaceChildren(...[
        binBar,
        el("h1", {}, "🔒 ", n.title || "Locked note"),
        n.deleted_at ? null : el("p", { class: "muted" }, n.user_locked ? "You locked this note. Tap the lock below to unlock it."
          : n.can_unlock ? `The safety check locked this note${n.lock_reason ? ` (${n.lock_reason})` : ""}. If that's wrong, tap the lock below to unlock it.`
          : "The safety check locked this note. It opens with your master password, which comes in a later build."),
      ].filter(Boolean));
      return;
    }
    const title = el("textarea", { class: "quiet title", rows: 1, placeholder: (!n.title && n.display_title) || "Title" });
    title.value = n.title || "";
    title.addEventListener("input", () => { autosize(title); queueSave({ title: title.value }); });
    title.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); bodyBox.focus(); } });
    const bodyBox = el("textarea", { class: `quiet body ${n.format === "quote" ? "quote" : ""}`, rows: 3, placeholder: "Note" });
    bodyBox.value = n.body || "";
    bodyBox.addEventListener("input", () => { autosize(bodyBox); queueSave({ body: bodyBox.value }); });
    const hasList = Array.isArray(n.list_items) && n.list_items.length;
    if (n.deleted_at) { title.readOnly = true; bodyBox.readOnly = true; }
    body.replaceChildren(...[
      binBar,
      imageBlock(n),
      designNotes(n),
      title,
      n.deleted_at ? null : Object.assign(chipsFor(n), { id: "d-chips" }),
      n.why_saved ? el("p", { class: "why-line" }, n.why_saved) : null,
      hasList ? el("ul", { class: "list-items" }, n.list_items.map((i) => el("li", {}, i.checked ? "☑ " : "☐ ", i.text))) : null,
      (!hasList || n.body) ? bodyBox : null,
      // Captured pages after Keith's own note: each is long, and his title, tags and why-saved line come first.
      ...capturedPages(n),
      otherImages(n),
      fromPage(n),
      related?.length ? el("h3", {}, "Related in your Hopper") : null,
      related?.length ? el("div", { class: "related" }, related.map(card)) : null,
    ].filter(Boolean));
    requestAnimationFrame(() => { autosize(title); autosize(bodyBox); });
    $("d-body").scrollTop = 0;
  } catch (e) { body.replaceChildren(el("p", { class: "muted" }, e.message)); }
}

async function closeDetail() {
  await flushSave();
  $("detail").hidden = true; document.body.style.overflow = ""; state.note = null;
  $("d-colours").hidden = true; $("d-menu").hidden = true;
}
$("detail-close").addEventListener("click", () => history.state?.note ? history.back() : (closeDetail(), history.replaceState({}, "", "/")));
$("detail").addEventListener("click", (e) => { if (e.target.id === "detail") $("detail-close").click(); });

// Pull down to dismiss (touch screens): with the note scrolled to the top, keep dragging down and the sheet
// follows your finger; let go past a short distance, or flick, and it closes. Otherwise it springs back.
(function pullToDismiss() {
  const sheet = $("d-sheet"), body = $("d-body"), overlay = $("detail");
  let y0 = null, dy = 0, t0 = 0, pulling = false;
  const springBack = () => {
    sheet.style.transition = "transform .2s ease-out";
    sheet.style.transform = ""; overlay.style.backgroundColor = "";
    setTimeout(() => (sheet.style.transition = ""), 220);
  };
  sheet.addEventListener("touchstart", (e) => {
    y0 = null;
    if (e.touches.length !== 1 || body.scrollTop > 0 || e.target.closest(".pop, .pg-whole")) return;
    y0 = e.touches[0].clientY; dy = 0; t0 = Date.now(); pulling = false;
  }, { passive: true });
  sheet.addEventListener("touchmove", (e) => {
    if (y0 == null) return;
    dy = e.touches[0].clientY - y0;
    if (!pulling) {
      if (dy < 0 || body.scrollTop > 0) { y0 = null; return; } // scrolling up into the note: leave it alone
      // From the very first downward move, take the gesture away from the browser so the note
      // never scrolls (or bounces) underneath while the sheet is moving.
      if (dy < 3) return; // ignore a jitter, so an upward scroll that starts with one still scrolls
      e.preventDefault();
      if (dy < 6) return;
      pulling = true; sheet.style.transition = "none"; sheet.classList.add("pulling");
      if (document.activeElement?.blur) document.activeElement.blur(); // drop the keyboard while pulling
    }
    e.preventDefault();
    const d = Math.max(0, dy - 6);
    sheet.style.transform = `translateY(${d}px)`;
    overlay.style.backgroundColor = `rgba(0,0,0,${(0.4 * Math.max(0, 1 - d / 450)).toFixed(3)})`;
  }, { passive: false });
  const end = () => {
    if (y0 == null) return;
    y0 = null;
    if (!pulling) return;
    pulling = false; sheet.classList.remove("pulling");
    const flick = dy / Math.max(1, Date.now() - t0) > 0.6;
    if (dy > 120 || (flick && dy > 40)) {
      sheet.style.transition = "transform .18s ease-in";
      sheet.style.transform = "translateY(100%)";
      setTimeout(() => $("detail-close").click(), 170); // closing saves any pending edits
    } else springBack();
  };
  sheet.addEventListener("touchend", end);
  sheet.addEventListener("touchcancel", end);
})();
addEventListener("popstate", () => route());

// Editor controls
$("d-pin").addEventListener("click", async () => {
  const n = state.note; if (!n) return;
  n.pinned = !n.pinned; setEditorChrome(n);
  await flushSave(); queueSave({ pinned: n.pinned }); await flushSave();
  toast(n.pinned ? "Pinned" : "Unpinned"); loadPinned();
});
$("d-archive").addEventListener("click", async () => {
  const n = state.note; if (!n) return;
  const archived = !n.archived;
  queueSave({ archived }); await flushSave();
  n.archived = archived;
  refreshCard(n.id, null);
  toast(archived ? "Archived" : "Moved back to notes");
  $("detail-close").click();
});
$("d-lock").addEventListener("click", async () => {
  const n = state.note; if (!n) return;
  if (!n.locked && !confirm("Lock this note? Its content will be hidden, and the AI won't see it, until you unlock it.")) return;
  if (n.locked && !n.user_locked && !confirm("Unlock this note? The AI will see it again, and the safety check won't lock it a second time.")) return;
  try {
    await flushSave();
    await api({ action: "lock", id: n.id, lock: !n.locked });
    toast(n.locked ? "Unlocked" : "Locked");
    if (n.locked) { openNote(n.id, false); resetFeed(); }
    else { refreshCard(n.id, { id: n.id, locked: true, title: n.title, created_at: n.created_at, user_locked: true }); $("detail-close").click(); }
  } catch (e) { toast(e.message); }
});
$("d-format").addEventListener("change", () => {
  const n = state.note; if (!n) return;
  n.format = $("d-format").value;
  queueSave({ format: n.format });
  document.querySelector("#d-body .quiet.body")?.classList.toggle("quote", n.format === "quote");
});
$("d-colour-btn").addEventListener("click", () => {
  const n = state.note; if (!n) return;
  $("d-menu").hidden = true;
  const pop = $("d-colours");
  if (!pop.hidden) { pop.hidden = true; return; }
  pop.replaceChildren(
    el("button", { class: `swatch none ${!n.color ? "on" : ""}`, title: "No colour", onclick: () => setColour(null) }, "⊘"),
    ...COLOURS.map((c) => el("button", { class: `swatch c-${c} ${n.color === c ? "on" : ""}`, title: c.toLowerCase(), onclick: () => setColour(c) })));
  pop.hidden = false;
});
function setColour(c) {
  const n = state.note; n.color = c;
  setEditorChrome(n); $("d-colours").hidden = true;
  queueSave({ color: c });
}
$("d-more").addEventListener("click", () => { $("d-colours").hidden = true; $("d-menu").hidden = !$("d-menu").hidden; });
$("d-open-link").addEventListener("click", () => { const u = state.note?.links?.[0]?.url; if (u) window.open(u, "_blank", "noopener"); $("d-menu").hidden = true; });
$("d-copy-link").addEventListener("click", async () => {
  $("d-menu").hidden = true;
  try { await navigator.clipboard.writeText(`${location.origin}/n/${state.note.id}`); toast("Link copied"); } catch { toast("Couldn't copy the link"); }
});
// Delete moves the note to the Bin (no confirmation: it can be restored from the Bin for 7 days).
$("d-delete").addEventListener("click", async () => {
  const n = state.note; $("d-menu").hidden = true;
  if (!n) return;
  try {
    await flushSave(); pending = {};
    const { erases_at } = await api({ action: "delete", id: n.id });
    refreshCard(n.id, null); toast(`Moved to the Bin. Erased ${fmtDate(erases_at)}.`); $("detail-close").click();
  } catch (e) { toast(e.message); }
});

// A note leaving the Bin view: drop its card, and step the page offset back so the next page doesn't skip one.
function leaveBin(id) {
  if (state.bin && document.querySelector(`#feed .card[data-id="${id}"]`)) state.binOffset = Math.max(0, state.binOffset - 1);
  refreshCard(id, null);
}

// The banner on a binned note: when it will be erased, Restore, and Delete forever.
function binBanner(n) {
  const restore = async () => {
    try { await api({ action: "restore", id: n.id }); leaveBin(n.id); toast("Restored"); openNote(n.id, false); }
    catch (e) { toast(e.message); }
  };
  const forever = async () => {
    if (!confirm("Delete this note for good? This can't be undone.")) return;
    try { await api({ action: "delete", id: n.id, forever: true }); leaveBin(n.id); toast("Deleted for good"); $("detail-close").click(); }
    catch (e) { toast(e.message); }
  };
  return el("div", { class: "bin-banner" },
    el("span", {}, `In the Bin. Erased ${fmtDate(n.erases_at)}.`),
    el("button", { class: "primary", onclick: restore }, "Restore"),
    el("button", { class: "danger", onclick: forever }, "Delete forever"));
}

function route() {
  const m = location.pathname.match(/^\/n\/([0-9a-f-]{36})$/);
  if (m) openNote(m[1], false); else if (!$("detail").hidden) closeDetail();
  if (!hasCards($("feed"))) resetFeed();
}

// ---------- capture (share sheet and New) ----------
function readShare() {
  if (location.pathname !== "/share") return;
  const p = new URLSearchParams(location.search);
  let url = p.get("url") || "", text = p.get("text") || "", title = p.get("title") || "";
  // Android usually puts the link in "text"; pull it out.
  if (!url) { const m = text.match(/https?:\/\/\S+/); if (m) { url = m[0]; text = text.replace(m[0], "").trim(); } }
  state.share = { url, text, title, images: Number(p.get("images") || 0) };
  history.replaceState({}, "", "/");
}

// HOP-7: images shared to Hopper wait in the service worker's "hopper-share" cache until saved or dismissed.
async function sharedImages(n) {
  const out = [];
  if (!n || !("caches" in window)) return out;
  try {
    const cache = await caches.open("hopper-share");
    for (let i = 0; i < n; i++) { const r = await cache.match(`/shared-image/${i}`); if (r) out.push(await r.blob()); }
  } catch {}
  return out;
}
async function clearSharedImages() { try { if ("caches" in window) await caches.delete("hopper-share"); } catch {} }

// Shrink an image to at most 1600 px on its long side, as JPEG, and return it base64-encoded.
async function shrink(blob) {
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  c.getContext("2d").drawImage(bmp, 0, 0, w, h);
  const out = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.85));
  const buf = new Uint8Array(await out.arrayBuffer());
  let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { data: btoa(bin), mime: "image/jpeg", width: w, height: h };
}

// A share saves the moment it arrives: no sheet stands between the share button and Hopper. The toast that
// confirms it offers "Add note", which opens the sheet on the saved note to add a why-saved line (or lock it).
// If the save fails, the sheet opens with the share on it, so nothing is lost and Save tries again.
async function saveShare(s) {
  if (!(s.url || s.text || s.title || s.blobs?.length)) return;
  toast("Saving to Hopper…", null, 0);
  const payload = { action: "capture", title: s.title || "", url: s.url || "", text: s.text || "", note: "", lock: false,
    route: "share", touch: navigator.maxTouchPoints > 1 };
  try {
    if (s.blobs?.length) payload.images = await Promise.all(s.blobs.slice(0, MAX_IMAGES).map(shrink));
    const r = await api(payload);
    clearSharedImages();
    toast(savedMessage(r), { label: "Add note", onclick: () => openCapture(s, r.saved) });
    if (!state.q && !state.archived) resetFeed();
  } catch (err) {
    openCapture(s);
    toast(`Not saved yet: ${err.message}`);
  }
}
function savedMessage(r) {
  const filed = (r && r.filed) || [];
  const firm = filed.filter((f) => f.band === "In").map((f) => f.project);
  const maybe = filed.filter((f) => f.band === "Nearby").map((f) => f.project);
  return firm.length ? `Saved, filed in ${firm.join(" and ")}` : maybe.length ? `Saved, maybe ${maybe[0]}` : "Saved to Hopper";
}

// Images on the capture sheet: the shared ones plus any Keith adds with the Image button, paste or drag
// and drop (desktop screenshots: Win+Shift+S, then Ctrl+V). The server takes up to four per note.
const MAX_IMAGES = 4;
// saved: the note a share has already been saved as. The sheet then edits that note (title, why-saved line, lock)
// instead of making a new one, and adding images is left to the open note.
function openCapture(s = null, saved = null) {
  state.share = s;
  state.saved = saved;
  state.capShared = !!(s && (s.url || s.text || s.blobs?.length));
  state.capImages = [...(s?.blobs || [])];
  $("c-title").value = saved?.title || s?.title || "";
  $("c-note").value = "";
  $("c-note").placeholder = state.capShared ? "Add a note, or why you saved it" : "Note";
  $("c-file").closest("label").hidden = !!saved;
  $("capture-save").textContent = saved ? "Save note" : "Save";
  $("c-lock").checked = false;
  renderCapturePreview();
  $("capture").hidden = false;
  requestAnimationFrame(() => { autosize($("c-title")); autosize($("c-note")); $("c-note").focus(); });
}
function renderCapturePreview() {
  const s = state.share, pv = $("c-preview");
  for (const u of state.capUrls || []) URL.revokeObjectURL(u);
  state.capUrls = state.capImages.map((b) => URL.createObjectURL(b));
  const thumbs = state.capImages.map((b, i) => el("span", { class: "p-thumb" },
    el("img", { src: state.capUrls[i], alt: "" }),
    state.saved ? null : el("button", { type: "button", class: "p-drop", "aria-label": "Remove image", onclick: () => { state.capImages.splice(i, 1); renderCapturePreview(); } }, "✕")));
  let host = ""; try { host = new URL(s?.url).hostname.replace(/^www\./, ""); } catch {}
  const hasText = !!(s && (s.url || s.text || (state.capShared && s.title)));
  pv.replaceChildren(...[
    thumbs.length ? el("div", { class: "p-imgs" }, ...thumbs) : null,
    hasText ? el("div", { class: "p-text" }, el("div", { class: "p-title" }, s.title || host || (thumbs.length ? "Shared image" : "Shared text")), el("div", { class: "p-sub", title: s.url || "" }, s.url ? shortUrl(s.url, 80) : s.text)) : null,
  ].filter(Boolean));
  pv.hidden = !thumbs.length && !hasText;
}
function addCaptureImages(files) {
  const imgs = [...files].filter((f) => f && f.type.startsWith("image/"));
  if (!imgs.length) return false;
  const room = MAX_IMAGES - state.capImages.length;
  if (imgs.length > room) toast(`Up to ${MAX_IMAGES} images per note`);
  state.capImages.push(...imgs.slice(0, Math.max(0, room)));
  renderCapturePreview();
  return true;
}
function closeCapture() {
  if (state.share?.blobs?.length) clearSharedImages();
  for (const u of state.capUrls || []) URL.revokeObjectURL(u);
  $("capture").hidden = true; state.share = null; state.saved = null; state.capImages = []; state.capUrls = [];
}
for (const id of ["c-title", "c-note"]) $(id).addEventListener("input", () => autosize($(id)));
$("c-title").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("c-note").focus(); } });
$("c-file").addEventListener("change", (e) => { addCaptureImages(e.target.files); e.target.value = ""; });
$("capture-form").addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.items || [])].filter((i) => i.kind === "file").map((i) => i.getAsFile());
  if (addCaptureImages(files)) e.preventDefault();
});
$("capture-form").addEventListener("dragover", (e) => { if ([...e.dataTransfer.types].includes("Files")) { e.preventDefault(); $("capture-form").classList.add("dragging"); } });
$("capture-form").addEventListener("dragleave", (e) => { if (!$("capture-form").contains(e.relatedTarget)) $("capture-form").classList.remove("dragging"); });
$("capture-form").addEventListener("drop", (e) => { $("capture-form").classList.remove("dragging"); if (e.dataTransfer.files?.length) { e.preventDefault(); addCaptureImages(e.dataTransfer.files); } });
$("new-btn").addEventListener("click", () => openCapture());
$("capture-cancel").addEventListener("click", closeCapture);
$("capture").addEventListener("click", (e) => { if (e.target.id === "capture") closeCapture(); });
$("capture-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (state.saved) { addNoteToSaved(); return; }
  const s = state.share;
  const shared = state.capShared, pics = state.capImages || [];
  const typed = $("c-note").value;
  const payload = { action: "capture", title: $("c-title").value, url: s?.url || "", lock: $("c-lock").checked,
    text: shared ? (s.text || "") : typed, note: shared ? typed : "",
    // HOP-43: how the note came in, and whether the screen takes touch (iPads report themselves as Macs).
    route: s ? "share" : "new", touch: navigator.maxTouchPoints > 1 };
  if (!payload.title.trim() && !payload.text.trim() && !payload.url && !payload.note.trim() && !pics.length) { toast("Nothing to save yet"); return; }
  $("capture-save").disabled = true;
  if (pics.length) {
    try { payload.images = await Promise.all(pics.map(shrink)); }
    catch { toast("Couldn't read the image"); $("capture-save").disabled = false; return; }
  }
  try {
    const r = await api(payload); closeCapture();
    toast(savedMessage(r));
    if (!state.q && !state.archived) resetFeed();
  }
  catch (err) { toast(err.message); }
  $("capture-save").disabled = false;
});

// The note added after a share: the why-saved line and any title change go on the saved note, then the lock.
async function addNoteToSaved() {
  const saved = state.saved;
  const why = $("c-note").value.trim(), title = $("c-title").value.trim(), lock = $("c-lock").checked;
  const fields = {};
  if (why) fields.why_saved = why;
  if (title !== (saved.title || "").trim()) fields.title = title;
  if (!Object.keys(fields).length && !lock) { closeCapture(); return; }
  $("capture-save").disabled = true;
  try {
    if (Object.keys(fields).length) await api({ action: "update", id: saved.id, ...fields });
    if (lock) await api({ action: "lock", id: saved.id, lock: true });
    closeCapture();
    toast(lock ? (why ? "Note added and locked" : "Locked") : why ? "Note added" : "Saved");
    if (!state.q && !state.archived) resetFeed();
  } catch (err) { toast(err.message); }
  $("capture-save").disabled = false;
}

// ---------- menu ----------
$("menu-btn").addEventListener("click", () => ($("menu").hidden = !$("menu").hidden));
$("all-projects-btn").addEventListener("click", openProjects);
$("signout-btn").addEventListener("click", async () => { $("menu").hidden = true; await sb.auth.signOut({ scope: "local" }); }); // this device only: a global sign-out also ends the phone's session and the claude.ai connector
for (const b of document.querySelectorAll("[data-close]")) b.addEventListener("click", () => closeOverlay(b.dataset.close));
function closeOverlay(id) { $(id).hidden = true; }

boot();

// Coming back to the app (switching from another app or tab) counts as an open too.
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && booted) track("open"); });
