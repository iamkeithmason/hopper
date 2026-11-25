"""Long-address check (HOP-41): a long unbroken URL must never make the page wider than the screen.

Opens the capture sheet with a shared Behance-style link carrying tracking parameters, an open note whose links have
no page title and whose text holds a long URL, and a card whose excerpt is one, at phone and desktop widths, and
checks nothing scrolls sideways. Runs the real app against a fake API in headless Chrome, like capture_check.py.
Run:  python3 tests/overflow_check.py         (needs: pip install playwright, and Chrome or Chromium)
"""
import functools, http.server, json, os, re, shutil, sys, tempfile, threading

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.environ.get("OVERFLOW_SHOTS")
LONG = ("https://www.behance.net/gallery/123456789/Some-Very-Long-Project-Name-For-A-Brand-Identity-System/modules/987654321"
        "?utm_source=android&utm_medium=share&utm_campaign=gallery_share_sheet&tracking_id=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789")
NOTE = {"id": "11111111-1111-1111-1111-111111111111", "locked": False, "title": "", "body": f"Look at this {LONG} later",
        "format": "bookmark", "created_at": "2026-11-19T20:00:00Z", "tags": [], "images": [],
        "links": [{"url": LONG, "page_title": None, "kind": "article"}, {"url": LONG + "&second=1", "page_title": None, "kind": "article"}]}
CARD = {"id": "22222222-2222-2222-2222-222222222222", "locked": False, "title": LONG, "excerpt": LONG, "format": "note",
        "created_at": "2026-11-19T20:00:00Z", "projects": [], "image": None}

STUB = """
const createClient = () => ({ auth: {
  getSession: async () => ({ data: { session: { access_token: "test" } } }),
  onAuthStateChange: (cb) => setTimeout(() => cb("SIGNED_IN"), 0),
  signInWithOtp: async () => ({}) } });
window.fetch = async (url, o) => {
  const b = JSON.parse(o.body); let r = {};
  if (b.action === "projects") r = { projects: [] };
  else if (b.action === "feed") r = { notes: b.cursor ? [] : [CARD] };
  else if (b.action === "note") r = { note: NOTE, related: [] };
  else if (b.action === "capture") r = { saved: { id: NOTE.id, title: null }, filed: [] };
  return new Response(JSON.stringify(r), { status: 200 });
};
"""


def chrome():
    for p in ("/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/opt/pw-browsers/chromium",
              "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"):
        if os.path.isfile(p):
            return p
    return None


def main():
    tmp = tempfile.mkdtemp()
    shutil.copytree(os.path.join(ROOT, "app"), tmp, dirs_exist_ok=True)
    js = open(os.path.join(tmp, "app.js")).read()
    stub = f"const NOTE = {json.dumps(NOTE)}, CARD = {json.dumps(CARD)};\n" + STUB
    js, n = re.subn(r'^import \{ createClient \} from .*$', lambda _: stub, js, count=1, flags=re.M)
    assert n == 1, "couldn't find the Supabase import in app.js to replace"
    open(os.path.join(tmp, "app.js"), "w").write(js)

    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a): pass
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=tmp))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{srv.server_address[1]}/index.html"

    failures = []
    def check(ok, msg):
        print(("PASS " if ok else "FAIL ") + msg)
        if not ok: failures.append(msg)
    wide = "document.documentElement.scrollWidth - document.documentElement.clientWidth"
    inner = "(s) => { const e = document.querySelector(s); return e ? e.scrollWidth - e.clientWidth : 0; }"

    with sync_playwright() as p:
        exe = chrome()
        b = p.chromium.launch(**({"executable_path": exe} if exe else {}))
        for w, h in ((390, 844), (1440, 900)):
            # A share, as Android sends it: /share?text=<link>
            pg = b.new_page(viewport={"width": w, "height": h})
            errors = []; pg.on("pageerror", lambda e: errors.append(str(e)))
            pg.add_init_script(f"history.replaceState(null, '', '/share?text=' + encodeURIComponent({json.dumps(LONG)}))")
            pg.goto(url); pg.wait_for_timeout(900)
            # Shares save on arrival; the sheet opens from the toast's Add note.
            pg.click("#toast .toast-act"); pg.wait_for_timeout(200)
            check(pg.is_visible("#capture"), f"{w}: Add note on a saved share opens the capture sheet")
            check(pg.evaluate(wide) <= 0, f"{w}: the page doesn't widen with the capture sheet open ({pg.evaluate(wide)}px)")
            check(pg.evaluate(inner, "#capture .sheet") <= 0, f"{w}: the capture sheet doesn't scroll sideways ({pg.evaluate(inner, '#capture .sheet')}px)")
            sub = pg.text_content("#c-preview .p-sub") or ""
            check(sub.startswith("behance.net/gallery/") and "utm_" not in sub, f"{w}: the preview shows a short address ({sub[:60]})")
            save = pg.locator("#capture-save").bounding_box()
            check(save and save["x"] + save["width"] <= w, f"{w}: the Save button stays on screen")
            if SHOTS: pg.screenshot(path=os.path.join(SHOTS, f"overflow-share-{w}.png"))
            check(not errors, f"{w}: no page errors on the sheet {errors[:1]}")
            pg.close()

            # An open note and the feed card behind it.
            pg = b.new_page(viewport={"width": w, "height": h})
            errors = []; pg.on("pageerror", lambda e: errors.append(str(e)))
            pg.add_init_script(f"history.replaceState(null, '', '/n/{NOTE['id']}')")
            pg.goto(url); pg.wait_for_timeout(900)
            check(pg.is_visible("#detail"), f"{w}: the note opens")
            check(pg.evaluate(wide) <= 0, f"{w}: the page doesn't widen with the note open ({pg.evaluate(wide)}px)")
            check(pg.evaluate(inner, "#d-body") <= 0, f"{w}: the note doesn't scroll sideways ({pg.evaluate(inner, '#d-body')}px)")
            links = pg.eval_on_selector_all(".from-page .p-link", "(a) => a.map((x) => [x.textContent, x.href, x.title])")
            check(len(links) == 2 and all(t.startswith("behance.net/") and len(t) < 60 and href.startswith("https://www.behance.net/") and title == href
                                          for t, href, title in links), f"{w}: untitled links show a short address and keep the full one")
            if SHOTS: pg.screenshot(path=os.path.join(SHOTS, f"overflow-note-{w}.png"))
            pg.evaluate("history.pushState({}, '', '/'); dispatchEvent(new PopStateEvent('popstate'))"); pg.wait_for_timeout(600)
            check(pg.is_hidden("#detail") and pg.locator(".card").count() > 0, f"{w}: back on the feed with the long-address card")
            check(pg.evaluate(wide) <= 0, f"{w}: the feed doesn't widen with a long-address card ({pg.evaluate(wide)}px)")
            check(not errors, f"{w}: no page errors on the note {errors[:1]}")
            pg.close()
        b.close()

    srv.shutdown(); shutil.rmtree(tmp)
    print("\nAll checks passed." if not failures else f"\n{len(failures)} check(s) failed.")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
