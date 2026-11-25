"""Pinned project pills (HOP-13): right-click (computer) or long-press (phone) pins a pill to the front of the row.

Runs the real app against a fake API in headless Chrome, like overflow_check.py. The fake API keeps pins in memory and
orders projects the way hopper-api does: pinned first, in pinning order, then by recent activity.
Run:  python3 tests/pin_check.py         (needs: pip install playwright, and Chrome or Chromium)
"""
import functools, http.server, os, re, shutil, sys, tempfile, threading

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

STUB = """
const createClient = () => ({ auth: {
  getSession: async () => ({ data: { session: { access_token: "test" } } }),
  onAuthStateChange: (cb) => setTimeout(() => cb("SIGNED_IN"), 0),
  signInWithOtp: async () => ({}) } });
const PROJECTS = [["a", "Alpha"], ["b", "Beta"], ["c", "Coracle"]].map(([id, name], i) => ({ id, name, notes: 3, last_activity: "2026-11-2" + (5 - i), pinned_at: null }));
let clock = 0; window.CALLS = [];
window.fetch = async (url, o) => {
  const b = JSON.parse(o.body); let r = {}; window.CALLS.push(b.action);
  if (b.action === "projects") r = { projects: [...PROJECTS].sort((x, y) => (x.pinned_at ?? 1e9) - (y.pinned_at ?? 1e9)).map(({ pinned_at, ...p }) => ({ ...p, pinned: pinned_at != null })) };
  else if (b.action === "pin_project") { const p = PROJECTS.find((x) => x.id === b.project_id); p.pinned_at = b.pinned ? (p.pinned_at ?? ++clock) : null; r = { ok: true, pinned: b.pinned }; }
  else if (b.action === "feed") r = { notes: [] };
  else if (b.action === "topics") r = { topics: [] };
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
    js, n = re.subn(r'^import \{ createClient \} from .*$', lambda _: STUB, js, count=1, flags=re.M)
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
    order = "() => [...document.querySelectorAll('#pills button')].map((b) => b.textContent.trim())"
    pinned = "() => [...document.querySelectorAll('#pills button.pinned')].map((b) => b.textContent.trim())"
    opened = "() => document.querySelector('#pills button.on')?.textContent.trim()"

    with sync_playwright() as p:
        exe = chrome()
        b = p.chromium.launch(**({"executable_path": exe} if exe else {}))
        pg = b.new_page(viewport={"width": 1440, "height": 900})
        errors = []; pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(url); pg.wait_for_timeout(800)
        check(pg.evaluate(order)[1:4] == ["Alpha", "Beta", "Coracle"], f"pills start in activity order ({pg.evaluate(order)})")
        pg.click("#pills button:has-text('Coracle')", button="right"); pg.wait_for_timeout(400)
        check(pg.evaluate(order)[1] == "Coracle", f"right-click pins Coracle to the front ({pg.evaluate(order)})")
        check(pg.evaluate(pinned) == ["Coracle"], "Coracle carries the pin mark")
        check(pg.evaluate(opened) == "All", "right-click doesn't open the project")
        check("Pinned Coracle" in (pg.text_content("#toast") or ""), "a toast says it was pinned")
        pg.click("#pills button:has-text('Beta')", button="right"); pg.wait_for_timeout(400)
        check(pg.evaluate(order)[1:4] == ["Coracle", "Beta", "Alpha"], f"a second pin goes after the first ({pg.evaluate(order)})")
        pg.click("#pills button:has-text('Coracle')", button="right"); pg.wait_for_timeout(400)
        check(pg.evaluate(order)[1:4] == ["Beta", "Alpha", "Coracle"], f"unpinning puts Coracle back by activity ({pg.evaluate(order)})")
        pg.click("#pills button:has-text('Alpha')"); pg.wait_for_timeout(300)
        check(pg.evaluate(opened) == "Alpha", "a plain click still opens the project")
        check(not errors, f"no script errors ({errors[:2]})")

        # Phone: the pills live in the navigation sheet (HOP-39). A touch long-press on a project there pins it, and the
        # tap that ends it doesn't open the project.
        ph = b.new_page(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True)
        perrors = []; ph.on("pageerror", lambda e: perrors.append(str(e)))
        ph.goto(url); ph.wait_for_timeout(800)
        check(ph.is_hidden("#pills") and ph.is_visible("#lb-open"), "phone: the bottom bar replaces the top pills")
        ph.tap("#lb-open"); ph.wait_for_timeout(200)
        sel = "#ns-list .ns-row:has-text('Coracle')"
        ph.eval_on_selector(sel, """(b) => { const r = b.getBoundingClientRect(), o = { pointerType: 'touch', bubbles: true, clientX: r.x + 5, clientY: r.y + 5 };
          b.dispatchEvent(new PointerEvent('pointerdown', o)); window.__b = b; window.__o = o; }""")
        ph.wait_for_timeout(750)
        ph.wait_for_timeout(300)  # the pills have re-rendered in the new order by now
        ph.evaluate("() => { __b.dispatchEvent(new PointerEvent('pointerup', __o)); document.elementFromPoint(__o.clientX, __o.clientY).click(); }")
        ph.wait_for_timeout(400)
        check(ph.evaluate(order)[1] == "Coracle" and "Coracle" in ph.evaluate(pinned), f"phone: a long-press pins Coracle, the last pill ({ph.evaluate(order)})")
        check(ph.evaluate(opened) == "All", "phone: the tap that ends the long-press doesn't open whichever project is now under it")
        check(ph.is_visible("#nav-sheet"), "phone: the sheet stays open after pinning")
        ph.eval_on_selector("#ns-list .ns-row:has-text('Alpha')", """(b) => { const r = b.getBoundingClientRect(), o = { pointerType: 'touch', bubbles: true, clientX: r.x + 5, clientY: r.y + 5 };
          b.dispatchEvent(new PointerEvent('pointerdown', o)); b.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: o.clientX + 40 })); }""")
        ph.wait_for_timeout(750)
        check(ph.evaluate(pinned) == ["Coracle"], "phone: scrolling the project list doesn't pin")
        ph.wait_for_timeout(1300)
        ph.tap("#ns-list .ns-row:has-text('Beta')"); ph.wait_for_timeout(300)
        check(ph.evaluate(opened) == "Beta" and ph.is_hidden("#nav-sheet"), "phone: a quick tap opens the project and closes the sheet")
        check(ph.text_content("#lb-where") == "Beta", "phone: the bar says where you are")
        check(not perrors, f"phone: no script errors ({perrors[:2]})")
        b.close()
    srv.shutdown()
    print(f"\n{len(failures)} failed" if failures else "\nall passed")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
