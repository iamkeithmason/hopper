"""WCAG AA contrast audit: every Keep colour (and none), light and dark mode, cards and the open note.

Renders the real app against a fake API in headless Chrome, then measures every visible piece of text
(and placeholder) against the background it actually sits on, compositing transparent layers and opacity.
Text needs 4.5:1. Chip outlines and icon buttons need 3:1 (non-text contrast).

Run:  python3 tests/contrast_check.py [--verbose]     (needs: pip install playwright, and Chrome or Chromium)
Exit code 0 means everything passes.
"""
import functools, http.server, json, os, re, shutil, sys, tempfile, threading

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COLOURS = [None, "RED", "ORANGE", "YELLOW", "GREEN", "TEAL", "BLUE", "CERULEAN", "PURPLE", "PINK", "BROWN", "GRAY"]
VERBOSE = "--verbose" in sys.argv

STUB = """
const createClient = () => ({ auth: {
  getSession: async () => ({ data: { session: { access_token: "test" } } }),
  onAuthStateChange: (cb) => setTimeout(() => cb("SIGNED_IN"), 0),
  signInWithOtp: async () => ({}) } });
const COLOURS_T = %s;
const uid = (k, kind) => "00000000-0000-0000-000" + kind + "-" + String(k).padStart(12, "0");
const PIC = "data:image/svg+xml," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='300' height='200'><rect width='100%%' height='100%%' fill='#456'/></svg>");
const cardOf = (k, kind) => ({ id: uid(k, kind), created_at: new Date(Date.UTC(2026, 10, 19) - k * 3600e3).toISOString(),
  format: kind === 1 ? "bookmark" : kind === 2 ? "quote" : "note", color: COLOURS_T[k], title: kind === 2 ? null : "Card title " + k,
  excerpt: "Excerpt text on a coloured card, long enough to wrap onto a second line.", host: "uk.pinterest.com",
  image: kind === 1 ? PIC : null, projects: ["Essays"] });
const FEED = COLOURS_T.flatMap((_, k) => [cardOf(k, 0), cardOf(k, 1), cardOf(k, 2)]);
window.fetch = async (url, o) => {
  const b = JSON.parse(o.body); let r = {};
  if (b.action === "projects") r = { projects: [{ id: "p1", name: "Essays", notes: 3, last_activity: "2026-11-18" }] };
  else if (b.action === "feed") r = { notes: b.pinned || b.before ? [] : FEED };
  else if (b.action === "note") {
    const k = Number(b.id.slice(-12));
    r = { note: { id: b.id, color: COLOURS_T[k], format: "bookmark", title: "", body: "Note text on the coloured background.",
        created_at: "2026-11-18T10:00:00Z", edited_at: "2026-11-19T11:45:00Z", why_saved: "Saved for the essay on craft.",
        tags: [{ kind: "project", name: "Essays", confidence: "high", confirmed: true },
               { kind: "topic", name: "Craft", confidence: "low", confirmed: false },
               { kind: "project", name: "Lurûn", added_by: "rule", near: "Beowulf at Heorot", confidence: "high" }],
        links: [{ url: "https://uk.pinterest.com/pin/123", page_title: "A pin on Pinterest", page_text: "Text fetched from the page." }] },
      related: [cardOf(0, 0), { ...cardOf(k, 0), id: uid(k, 3) }] };
  }
  return new Response(JSON.stringify(r), { status: 200 });
};
""" % json.dumps(COLOURS)

# Runs in the page: returns failures for the current screen. Colours are read back through a canvas pixel,
# so any CSS colour syntax (rgb, color(), color-mix) is handled.
AUDIT = r"""(scope) => {
  const cv = document.createElement("canvas"); cv.width = cv.height = 1;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  const rgba = (s) => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = "#000"; cx.fillStyle = s; cx.fillRect(0, 0, 1, 1);
    const d = cx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const over = (top, under) => { const a = top[3]; return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)).concat(1); };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const bgOf = (el) => { const layers = []; let opacity = 1;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const cs = getComputedStyle(e); opacity *= Number(cs.opacity);
      if (cs.backgroundImage !== "none" && e !== el) return null; // over an image or gradient: not measurable
      const c = rgba(cs.backgroundColor); if (c[3] > 0) layers.push(c);
      if (c[3] >= 1) break; }
    let bg = [255, 255, 255, 1]; for (const l of layers.reverse()) bg = over(l, bg);
    return { bg, opacity }; };
  const visible = (e) => { const r = e.getBoundingClientRect(); if (!r.width || !r.height) return false;
    for (let x = e; x && x.nodeType === 1; x = x.parentElement) { const cs = getComputedStyle(x);
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0 || x.hidden) return false; }
    return true; };
  const out = []; const root = document.querySelector(scope);
  const label = (e) => (e.id ? "#" + e.id : "") + (e.className && typeof e.className === "string" ? "." + e.className.trim().split(/\s+/).join(".") : e.tagName.toLowerCase());
  const check = (e, colour, need, what) => {
    const b = bgOf(e); if (!b) return;
    const fg = over([...colour.slice(0, 3), colour[3] * b.opacity], b.bg);
    const r = ratio(fg, b.bg);
    out.push({ el: label(e), what, ratio: Math.round(r * 100) / 100, need, ok: r >= need });
  };
  for (const e of root.querySelectorAll("*")) {
    if (!visible(e) || e.closest(".hover")) continue;
    const cs = getComputedStyle(e);
    const ownText = [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (ownText || e.tagName === "SELECT") check(e, rgba(cs.color), 4.5, "text: " + (e.textContent.trim().slice(0, 28) || e.value));
    if ((e.tagName === "TEXTAREA" || e.tagName === "INPUT") && !e.value && e.placeholder)
      check(e, rgba(getComputedStyle(e, "::placeholder").color), 4.5, "placeholder: " + e.placeholder);
    if (e.matches(".chip.unsure, .chip.add")) check(e, rgba(cs.borderTopColor), 3, "chip outline");
    if (e.matches(".icon-btn") && e.querySelector("svg")) check(e, rgba(cs.color), 3, "icon");
  }
  return out;
}"""


def chrome():
    for p in ("/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
              "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"):
        if os.path.exists(p):
            return p
    return None


def main():
    tmp = tempfile.mkdtemp()
    shutil.copytree(os.path.join(ROOT, "app"), tmp, dirs_exist_ok=True)
    js = open(os.path.join(tmp, "app.js")).read()
    js, n = re.subn(r'^import \{ createClient \} from .*$', STUB, js, count=1, flags=re.M)
    assert n == 1, "couldn't find the Supabase import in app.js to replace"
    open(os.path.join(tmp, "app.js"), "w").write(js)

    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a): pass
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=tmp))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{srv.server_address[1]}/index.html"

    fails, total = [], 0
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=chrome())
        for mode in ("light", "dark"):
            pg = b.new_page(viewport={"width": 1400, "height": 1000}, color_scheme=mode)
            pg.goto(url); pg.wait_for_timeout(1000)
            for r in pg.evaluate(AUDIT, "#feed"):
                total += 1
                if not r["ok"]: fails.append((mode, "feed", r))
                elif VERBOSE: print(mode, "feed", r)
            for r in pg.evaluate(AUDIT, "#top"):
                total += 1
                if not r["ok"]: fails.append((mode, "header", r))
            for k, colour in enumerate(COLOURS):
                cid = "00000000-0000-0000-0000-" + str(k).zfill(12)
                pg.click(f'#feed .card[data-id="{cid}"]'); pg.wait_for_timeout(250)
                for r in pg.evaluate(AUDIT, "#d-sheet"):
                    total += 1
                    if not r["ok"]: fails.append((mode, f"note {colour or 'none'}", r))
                    elif VERBOSE: print(mode, colour, r)
                pg.evaluate("document.getElementById('detail-close').click()"); pg.wait_for_timeout(150)
            pg.close()
        b.close()
    srv.shutdown(); shutil.rmtree(tmp)

    seen = set()
    for mode, where, r in fails:
        key = (mode, where, r["el"], r["what"])
        if key in seen: continue
        seen.add(key)
        print(f"FAIL {mode:5} {where:15} {r['ratio']:>5}:1 (needs {r['need']})  {r['el']}  {r['what']}")
    print(f"\n{total - len(fails)} of {total} checks pass AA." if fails else f"\nAll {total} checks pass AA.")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
