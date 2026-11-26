"""Deleting a locked note without unlocking it: the ⋯ menu stays on a locked note with only the safe items, Move to Bin
asks first, cancelling keeps the note, and once binned the note stays locked with Delete forever in its banner.

Runs the real app against a fake API in headless Chrome, like pin_check.py.
Run:  python3 tests/locked_delete_check.py   (needs: pip install playwright, and Chrome or Chromium)
"""
import functools, http.server, os, re, shutil, sys, tempfile, threading

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ID = "11111111-1111-4111-8111-111111111111"

STUB = """
const createClient = () => ({ auth: {
  getSession: async () => ({ data: { session: { access_token: "test" } } }),
  onAuthStateChange: (cb) => setTimeout(() => cb("SIGNED_IN"), 0),
  signInWithOtp: async () => ({}) } });
const NOTE = { id: "%s", locked: true, title: null, created_at: "2026-11-26T13:56:00Z", user_locked: false, can_unlock: true, lock_reason: null };
window.CALLS = [];
window.fetch = async (url, o) => {
  const b = JSON.parse(o.body); let r = {}; window.CALLS.push(b);
  if (b.action === "feed") r = { notes: NOTE.deleted_at ? [] : [{ ...NOTE }] };
  else if (b.action === "note") r = { note: { ...NOTE } };
  else if (b.action === "delete" && !b.forever) { NOTE.deleted_at = "2026-11-26T14:00:00Z"; NOTE.erases_at = "2026-12-03T14:00:00Z"; r = { ok: true, binned: true, deleted_at: NOTE.deleted_at, erases_at: NOTE.erases_at }; }
  else if (b.action === "delete" && b.forever) r = { ok: true, erased: true };
  else if (b.action === "projects") r = { projects: [] };
  else if (b.action === "topics") r = { topics: [] };
  return new Response(JSON.stringify(r), { status: 200 });
};
""" % ID


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
    deletes = "() => CALLS.filter((c) => c.action === 'delete')"

    with sync_playwright() as p:
        exe = chrome()
        b = p.chromium.launch(**({"executable_path": exe} if exe else {}))
        for name, vp, more in (("desktop", {"width": 1440, "height": 900}, "#d-more"), ("phone", {"width": 390, "height": 844}, "#d-more2")):
            pg = b.new_page(viewport=vp)
            errors = []; pg.on("pageerror", lambda e: errors.append(str(e)))
            pg.goto(url); pg.wait_for_timeout(800)
            pg.click("#feed .card.locked"); pg.wait_for_timeout(400)
            check(pg.is_visible(more), f"{name}: a locked note shows the ⋯ menu")
            check(all(pg.is_hidden(s) for s in ("#d-pin", "#d-archive", "#d-colour-btn", "#d-format")), f"{name}: editing controls stay hidden")
            pg.click(more); pg.wait_for_timeout(200)
            check(pg.is_visible("#d-delete") and pg.is_hidden("#d-open-link"), f"{name}: the menu offers Move to Bin and hides the original link")

            asked = []
            pg.once("dialog", lambda d: (asked.append(d.message), d.dismiss()))
            pg.click("#d-delete"); pg.wait_for_timeout(300)
            check(bool(asked) and "locked" in asked[0], f"{name}: Move to Bin asks first")
            check(pg.evaluate(deletes) == [], f"{name}: cancelling sends nothing")

            pg.click(more); pg.wait_for_timeout(200)
            pg.once("dialog", lambda d: d.accept())
            pg.click("#d-delete"); pg.wait_for_timeout(500)
            check(pg.evaluate(deletes) == [{"action": "delete", "id": ID}], f"{name}: confirming moves it to the Bin ({pg.evaluate(deletes)})")
            check(pg.is_hidden("#detail"), f"{name}: the note closes")

            pg.evaluate(f"() => history.pushState({{}}, '', '/n/{ID}')"); pg.evaluate("() => dispatchEvent(new PopStateEvent('popstate'))")
            pg.wait_for_timeout(500)
            check(pg.is_visible(".bin-banner button.danger") and pg.is_hidden(more), f"{name}: in the Bin it stays locked, with Delete forever in the banner")
            pg.once("dialog", lambda d: d.accept())
            pg.click(".bin-banner button.danger"); pg.wait_for_timeout(400)
            check(pg.evaluate(deletes)[-1] == {"action": "delete", "id": ID, "forever": True}, f"{name}: Delete forever erases it")
            check(not errors, f"{name}: no script errors ({errors[:2]})")
            pg.evaluate("() => { CALLS.length = 0; }")
            pg.close()
        b.close()
    srv.shutdown()
    print(f"\n{len(failures)} failed" if failures else "\nall passed")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
