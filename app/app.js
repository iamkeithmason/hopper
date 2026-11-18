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
const state = { projects: [], project: null, topic: null, q: "", archived: false, oldest: null, loading: false, done: false, share: null, note: null, tagOptions: null };

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
function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2600); }
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
  if (r.status === 401) throw new Error("This account isn't Hopper's owner.");
  if (!r.ok) throw new Error(j.error || `Error ${r.status}`);
  return j;
}

// ---------- screens ----------
function show(screen) { for (const s of ["signin", "home"]) $(s).hidden = s !== screen; }

let booted = false;
const PENDING = "hopper.pendingShare";
async function boot() {
  if (booted) return;
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  readShare();
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
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
      if (p && Date.now() - p.at < 86400000) state.share = { url: p.url || "", text: p.text || "", title: p.title || "" };
    } catch {}
  }
  try { localStorage.removeItem(PENDING); } catch {}
  if (booted) return;
  booted = true;
  show("home");
  try {
    await loadProjects();
    route();
    if (state.share) openCapture(state.share);
  } catch (e) { $("status").textContent = e.message; }
}

sb.auth.onAuthStateChange((event) => {
  if (event === "SIGNED_IN") boot();
  if (event === "SIGNED_OUT") { booted = false; show("signin"); }
});

$("signin-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("email").value.trim();
  const back = location.origin + location.pathname + location.search;
  const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: back } });
  $("signin-msg").textContent = error ? error.message : "Check your email for a sign-in link. Open it on this device.";
});

// ---------- projects and pills ----------
async function loadProjects() {
  const { projects } = await api({ action: "projects" });
  state.projects = projects;
  renderPills();
}

function renderPills() {
  const nav = $("pills"); nav.replaceChildren();
  const pill = (label, id) => el("button", { class: state.project === id ? "on" : "", onclick: () => pickProject(id) }, label);
  nav.append(pill("All", null), ...state.projects.map((p) => pill(p.name, p.id)), el("button", { onclick: openProjects }, "All projects →"));
}

async function pickProject(id) {
  state.project = id; state.topic = null; state.q = ""; $("q").value = "";
  renderPills();
  const sub = $("subpills");
  if (!id) { sub.hidden = true; } else {
    sub.hidden = false; sub.replaceChildren();
    const { topics } = await api({ action: "topics", project_id: id });
    const tp = (label, name) => el("button", { class: state.topic === name ? "on" : "", onclick: () => { state.topic = name; pickTopic(); } }, label);
    sub.append(tp("All topics", null), ...topics.map((t) => tp(t.name, t.name)));
  }
  resetFeed();
}
function pickTopic() { for (const b of $("subpills").children) b.classList.toggle("on", b.textContent === (state.topic ?? "All topics")); resetFeed(); }

function openProjects() {
  $("menu").hidden = true;
  const g = $("projects-grid"); g.replaceChildren();
  for (const p of state.projects) g.append(el("button", { onclick: () => { closeOverlay("projects-sheet"); setArchived(false); pickProject(p.id); } }, el("b", {}, p.name), el("span", { class: "muted" }, `${p.notes} notes · ${fmtDate(p.last_activity)}`)));
  $("projects-sheet").hidden = false;
}

function setArchived(on) {
  state.archived = on;
  $("view-banner").hidden = !on;
  $("view-title").textContent = on ? "Archived" : "";
  $("pills").hidden = on; $("subpills").hidden = on || !state.project;
}
$("archived-btn").addEventListener("click", () => { $("menu").hidden = true; state.project = null; state.topic = null; state.q = ""; $("q").value = ""; setArchived(true); resetFeed(); });
$("view-exit").addEventListener("click", () => { setArchived(false); renderPills(); resetFeed(); });

// ---------- feed ----------
function card(n) {
  if (n.locked) return el("div", { class: "card locked", "data-id": n.id, onclick: () => openNote(n.id) }, "🔒 ", fmtDate(n.created_at), n.title ? el("div", {}, n.title) : null);
  const projects = (n.projects || []).join(" · ");
  return el("div", { class: `card ${n.format || ""} ${colourClass(n.color)}`, "data-id": n.id, onclick: () => openNote(n.id) },
    n.pinned ? (() => { const s = icon("pinned"); s.classList.add("pin-mark"); return s; })() : null,
    n.image ? el("img", { src: n.image, loading: "lazy", alt: "", onerror: (e) => e.target.remove() }) : null,
    (n.title || n.excerpt) ? el("div", { class: "c-text" },
      n.title ? el("p", { class: "c-title" }, n.title) : null,
      n.excerpt ? el("div", { class: "c-excerpt" }, n.excerpt) : null,
      el("div", { class: "c-foot" }, n.format ? el("span", { class: "badge" }, n.format) : null, n.host ? el("span", {}, n.host) : null)) : null,
    el("div", { class: "hover" }, projects ? el("b", {}, projects) : null, el("span", {}, fmtDate(n.created_at)), n.host ? el("span", {}, n.host) : null));
}

async function loadPinned() {
  const wrap = $("pinned-wrap");
  if (state.q || state.archived) { wrap.hidden = true; return; }
  try {
    const { notes } = await api({ action: "feed", pinned: true, project_id: state.project, topic: state.topic, limit: 40 });
    $("pinned").replaceChildren(...notes.map(card));
    wrap.hidden = notes.length === 0;
  } catch { wrap.hidden = true; }
}

function resetFeed() {
  state.oldest = null; state.done = false; $("feed").replaceChildren(); $("status").textContent = "";
  window.scrollTo({ top: 0 });
  loadPinned();
  loadMore();
}

async function loadMore() {
  if (state.loading || state.done) return;
  state.loading = true; $("more").textContent = "Loading…";
  try {
    if (state.q) {
      const { notes } = await api({ action: "search", q: state.q });
      $("feed").append(...notes.map(card));
      $("status").textContent = notes.length ? `Closest matches for “${state.q}”` : `Nothing close to “${state.q}”`;
      state.done = true;
    } else {
      const { notes } = await api({ action: "feed", project_id: state.project, topic: state.topic, before: state.oldest, archived: state.archived, pinned: state.archived ? undefined : false, limit: 40 });
      $("feed").append(...notes.map(card));
      if (notes.length) state.oldest = notes[notes.length - 1].created_at;
      if (notes.length < 40) state.done = true;
      if (state.archived && !$("feed").children.length) $("status").textContent = "Nothing archived.";
    }
  } catch (e) { $("status").textContent = e.message; state.done = true; }
  state.loading = false; $("more").textContent = "";
}

new IntersectionObserver((es) => { if (es[0].isIntersecting) loadMore(); }, { rootMargin: "800px" }).observe($("more"));

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
    if (!next) old.remove(); else old.replaceWith(card(next));
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
  return { id: n.id, locked: false, title: n.title, excerpt: (n.body || n.summary || "").slice(0, 220), format: n.format, created_at: n.created_at,
    image: n.images?.[0]?.url ?? n.links?.[0]?.thumbnail_url ?? null, host, projects: (n.tags || []).filter((t) => t.kind === "project").map((t) => t.name), pinned: n.pinned, color: n.color };
}

function setEditorChrome(n) {
  const sheet = $("d-sheet");
  sheet.className = `sheet tall detail ${colourClass(n?.color)}`;
  const locked = !n || n.locked;
  for (const id of ["d-pin", "d-archive", "d-colour-btn", "d-format", "d-more"]) $(id).hidden = locked;
  $("d-lock").hidden = !n || (n.locked && !(n.can_unlock ?? n.user_locked));
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

function chipsFor(n) {
  const wrap = el("div", { class: "chips" });
  for (const t of n.tags || []) {
    const unsure = t.confidence === "low" && !t.confirmed;
    // Project tags filed by closeness can be confirmed too; confirming makes the note an anchor for that project.
    const confirmable = unsure || (t.kind === "project" && t.added_by === "rule" && !t.confirmed);
    const why = t.near ? `Filed near “${t.near}”` : unsure ? "The AI isn't sure about this one" : "";
    const chip = el("span", { class: `chip ${unsure ? "unsure" : ""}`, title: why },
      el("span", { class: "k" }, t.kind), t.name, unsure ? "?" : "",
      t.near ? el("span", { class: "near" }, `near ${t.near}`) : null,
      confirmable ? el("span", { class: "ok", title: "Confirm", onclick: (e) => { e.stopPropagation(); tagOp(t, "confirm"); } }, "✓") : null,
      el("span", { class: "x", title: "Remove", onclick: (e) => { e.stopPropagation(); tagOp(t, "remove"); } }, "✕"));
    chip.addEventListener("click", () => { const open = chip.classList.contains("open"); wrap.querySelectorAll(".chip.open").forEach((c) => c.classList.remove("open")); chip.classList.toggle("open", !open); });
    wrap.append(chip);
  }
  wrap.append(el("span", { class: "chip add", onclick: openTagPicker }, "+ Tag"));
  return wrap;
}

async function tagOp(t, op) {
  const n = state.note;
  try {
    await api({ action: "tag", id: n.id, kind: t.kind, name: t.name, op });
    if (op === "remove") n.tags = n.tags.filter((x) => !(x.kind === t.kind && x.name === t.name));
    if (op === "confirm") { t.confirmed = true; t.confidence = "high"; }
    $("d-chips").replaceWith(Object.assign(chipsFor(n), { id: "d-chips" }));
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
    $("d-chips").replaceWith(Object.assign(chipsFor(n), { id: "d-chips" }));
    closeOverlay("tag-sheet");
    refreshCard(n.id, cardFromNote(n));
  } catch (e) { toast(e.message); }
}

// What Hopper fetched from a note's link, set apart from Keith's own note:
// a player for YouTube and Vimeo, otherwise the page's picture; then its title, site and description.
const VIDEO = [
  [/^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/i, (id) => `https://www.youtube-nocookie.com/embed/${id}`],
  [/^https?:\/\/(?:www\.)?vimeo\.com\/(\d+)/i, (id) => `https://player.vimeo.com/video/${id}`],
];
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
  return el("section", { class: "from-page" },
    el("div", { class: "divider" }, "From the page"),
    media,
    el("a", { class: "p-link", href: l.url, target: "_blank", rel: "noopener noreferrer" }, l.page_title || l.url, " ↗"),
    el("span", { class: "p-host" }, host),
    desc ? el("p", { class: "p-desc" }, String(desc).slice(0, 600)) : null,
    ...n.links.slice(1).map((x) => el("a", { class: "p-link", href: x.url, target: "_blank", rel: "noopener noreferrer" }, x.page_title || x.url, " ↗")));
}

async function openNote(id, push = true) {
  if (push) history.pushState({ note: id }, "", `/n/${id}`);
  state.note = null; pending = {};
  const body = $("d-body"); body.replaceChildren(el("p", { class: "muted" }, "Loading…"));
  setEditorChrome(null); $("d-meta").textContent = "";
  $("d-colours").hidden = true; $("d-menu").hidden = true;
  $("d-sheet").style.transform = ""; $("d-sheet").style.transition = ""; $("detail").style.backgroundColor = "";
  $("detail").hidden = false; document.body.style.overflow = "hidden";
  try {
    const { note: n, related } = await api({ action: "note", id });
    state.note = n;
    setEditorChrome(n);
    if (n.locked) {
      body.replaceChildren(...[
        el("h1", {}, "🔒 ", n.title || "Locked note"),
        el("p", { class: "muted" }, n.user_locked ? "You locked this note. Tap the lock below to unlock it."
          : n.can_unlock ? `The safety check locked this note${n.lock_reason ? ` (${n.lock_reason})` : ""}. If that's wrong, tap the lock below to unlock it.`
          : "The safety check locked this note. It opens with your master password, which comes in a later build."),
      ]);
      return;
    }
    const title = el("textarea", { class: "quiet title", rows: 1, placeholder: "Title" });
    title.value = n.title || "";
    title.addEventListener("input", () => { autosize(title); queueSave({ title: title.value }); });
    title.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); bodyBox.focus(); } });
    const bodyBox = el("textarea", { class: `quiet body ${n.format === "quote" ? "quote" : ""}`, rows: 3, placeholder: "Note" });
    bodyBox.value = n.body || "";
    bodyBox.addEventListener("input", () => { autosize(bodyBox); queueSave({ body: bodyBox.value }); });
    const hasList = Array.isArray(n.list_items) && n.list_items.length;
    body.replaceChildren(...[
      n.images?.length ? el("div", { class: "d-images" }, n.images.filter((i) => i.url).map((i) => el("img", { src: i.url, alt: i.caption || "" }))) : null,
      title,
      Object.assign(chipsFor(n), { id: "d-chips" }),
      n.why_saved ? el("p", { class: "why-line" }, n.why_saved) : null,
      hasList ? el("ul", { class: "list-items" }, n.list_items.map((i) => el("li", {}, i.checked ? "☑ " : "☐ ", i.text))) : null,
      (!hasList || n.body) ? bodyBox : null,
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
    if (e.touches.length !== 1 || body.scrollTop > 0 || e.target.closest(".pop")) return;
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
$("d-delete").addEventListener("click", async () => {
  const n = state.note; $("d-menu").hidden = true;
  if (!n || !confirm("Delete this note for good? This can't be undone.")) return;
  try { pending = {}; await api({ action: "delete", id: n.id }); refreshCard(n.id, null); toast("Deleted"); $("detail-close").click(); }
  catch (e) { toast(e.message); }
});

function route() {
  const m = location.pathname.match(/^\/n\/([0-9a-f-]{36})$/);
  if (m) openNote(m[1], false); else if (!$("detail").hidden) closeDetail();
  if (!$("feed").children.length) resetFeed();
}

// ---------- capture (share sheet and New) ----------
function readShare() {
  if (location.pathname !== "/share") return;
  const p = new URLSearchParams(location.search);
  let url = p.get("url") || "", text = p.get("text") || "", title = p.get("title") || "";
  // Android usually puts the link in "text"; pull it out.
  if (!url) { const m = text.match(/https?:\/\/\S+/); if (m) { url = m[0]; text = text.replace(m[0], "").trim(); } }
  state.share = { url, text, title };
  history.replaceState({}, "", "/");
}

function openCapture(s = null) {
  state.share = s;
  const shared = !!(s && (s.url || s.text));
  $("c-title").value = s?.title || "";
  $("c-note").value = "";
  $("c-note").placeholder = shared ? "Add a note, or why you saved it" : "Note";
  $("c-lock").checked = false;
  const pv = $("c-preview");
  if (shared) {
    let host = ""; try { host = new URL(s.url).hostname.replace(/^www\./, ""); } catch {}
    pv.replaceChildren(el("div", { class: "p-text" }, el("div", { class: "p-title" }, s.title || host || "Shared text"), el("div", { class: "p-sub" }, s.url || s.text)));
    pv.hidden = false;
  } else pv.hidden = true;
  $("capture").hidden = false;
  requestAnimationFrame(() => { autosize($("c-title")); autosize($("c-note")); $("c-note").focus(); });
}
function closeCapture() { $("capture").hidden = true; state.share = null; }
for (const id of ["c-title", "c-note"]) $(id).addEventListener("input", () => autosize($(id)));
$("c-title").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("c-note").focus(); } });
$("new-btn").addEventListener("click", () => openCapture());
$("capture-cancel").addEventListener("click", closeCapture);
$("capture").addEventListener("click", (e) => { if (e.target.id === "capture") closeCapture(); });
$("capture-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const s = state.share;
  const shared = !!(s && (s.url || s.text));
  const typed = $("c-note").value;
  const payload = { action: "capture", title: $("c-title").value, url: s?.url || "", lock: $("c-lock").checked,
    text: shared ? (s.text || "") : typed, note: shared ? typed : "" };
  if (!payload.title.trim() && !payload.text.trim() && !payload.url && !payload.note.trim()) { toast("Nothing to save yet"); return; }
  $("capture-save").disabled = true;
  try {
    const r = await api(payload); closeCapture();
    const filed = (r && r.filed) || [];
    const firm = filed.filter((f) => f.band === "In").map((f) => f.project);
    const maybe = filed.filter((f) => f.band === "Nearby").map((f) => f.project);
    toast(firm.length ? `Saved, filed in ${firm.join(" and ")}` : maybe.length ? `Saved, maybe ${maybe[0]}` : "Saved to Hopper");
    if (!state.q && !state.archived) resetFeed();
  }
  catch (err) { toast(err.message); }
  $("capture-save").disabled = false;
});

// ---------- menu ----------
$("menu-btn").addEventListener("click", () => ($("menu").hidden = !$("menu").hidden));
$("all-projects-btn").addEventListener("click", openProjects);
$("signout-btn").addEventListener("click", async () => { $("menu").hidden = true; await sb.auth.signOut(); });
for (const b of document.querySelectorAll("[data-close]")) b.addEventListener("click", () => closeOverlay(b.dataset.close));
function closeOverlay(id) { $(id).hidden = true; }

boot();
