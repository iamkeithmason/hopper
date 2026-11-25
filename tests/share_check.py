"""Share check: a share saves the moment it arrives, and a note is optional afterwards.

Opens the app as Android's share sheet does (/share?text=<link>) and checks: one capture call goes out with route
"share" and no note, no sheet stands in the way, and the toast says Saved with an "Add note" button. Add note opens
the sheet on the saved note (Save note, no Image button); saving sends the why-saved line as an update and the lock
as a lock call, with no second capture. A failed save opens the sheet with the share on it, so nothing is lost.
Runs the real app against a fake API in headless Chrome, like capture_check.py.
Run:  python3 tests/share_check.py         (needs: pip install playwright, and Chrome or Chromium)
"""
import functools, http.server, json, os, re, shutil, sys, tempfile, threading

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.environ.get("SHARE_SHOTS")
LINK = "https://example.com/gallery/brand-system"

STUB = """
const createClient = () => ({ auth: {
  getSession: async () => ({ data: { session: { access_token: "test" } } }),
  onAuthStateChange: (cb) => setTimeout(() => cb("SIGNED_IN"), 0),
  signInWithOtp: async () => ({}) } });
window.CALLS = [];
window.fetch = async (url, o) => {
  const b = JSON.parse(o.body); CALLS.push(b); let r = {};
  if (b.action === "projects") r = { projects: [] };
  else if (b.action === "feed") r = { notes: [] };
  else if (b.action === "capture") {
    if (window.FAIL_CAPTURE) return new Response(JSON.stringify({ error: "offline" }), { status: 500 });
    await new Promise((res) => setTimeout(res, 150));
    r = { saved: { id: "33333333-3333-3333-3333-333333333333", title: "Brand system" }, filed: [{ project: "Portfolio", band: "In" }] };
  }
  else if (b.action === "update") r = { note: { id: b.id } };
  else if (b.action === "lock") r = { ok: true, locked: b.lock };
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
    calls = lambda pg, a: pg.evaluate(f"CALLS.filter((c) => c.action === '{a}')")
    share = f"history.replaceState(null, '', '/share?text=' + encodeURIComponent('Look at this ' + {json.dumps(LINK)}))"

    with sync_playwright() as p:
        exe = chrome()
        b = p.chromium.launch(**({"executable_path": exe} if exe else {}))
        for w, h in ((390, 844), (1440, 900)):
            pg = b.new_page(viewport={"width": w, "height": h})
            errors = []; pg.on("pageerror", lambda e: errors.append(str(e)))
            pg.add_init_script(share)
            pg.goto(url); pg.wait_for_timeout(1000)
            cap = calls(pg, "capture")
            check(len(cap) == 1, f"{w}: the share saves on arrival with one capture call ({len(cap)})")
            if cap:
                c = cap[0]
                check(c.get("url") == LINK and c.get("text") == "Look at this" and c.get("note") == "" and c.get("route") == "share",
                      f"{w}: the capture carries the link, the shared text, no note and route share")
            check(pg.is_hidden("#capture"), f"{w}: no sheet stands between the share and the save")
            t = pg.text_content("#toast") or ""
            check(pg.is_visible("#toast") and "Saved, filed in Portfolio" in t, f"{w}: the toast says it's saved ({t})")
            check(pg.is_visible("#toast .toast-act"), f"{w}: the toast offers Add note")
            box = pg.locator("#toast").bounding_box()
            check(box and box["x"] >= 0 and box["x"] + box["width"] <= w, f"{w}: the toast fits on screen")
            if SHOTS: pg.screenshot(path=os.path.join(SHOTS, f"share-saved-{w}.png"))

            pg.click("#toast .toast-act"); pg.wait_for_timeout(250)
            check(pg.is_visible("#capture"), f"{w}: Add note opens the sheet")
            check(pg.text_content("#capture-save") == "Save note", f"{w}: the sheet's button says Save note")
            check(pg.is_hidden("label:has(#c-file)"), f"{w}: the Image button is hidden on a saved share")
            check(pg.input_value("#c-title") == "Brand system", f"{w}: the title is the saved note's")
            if SHOTS: pg.screenshot(path=os.path.join(SHOTS, f"share-note-{w}.png"))
            pg.fill("#c-note", "Lovely type pairing")
            pg.click("label:has(#c-lock)")
            pg.click("#capture-save"); pg.wait_for_timeout(400)
            up = calls(pg, "update")
            check(len(up) == 1 and up[0].get("why_saved") == "Lovely type pairing" and "title" not in up[0]
                  and up[0].get("id") == "33333333-3333-3333-3333-333333333333", f"{w}: the note goes on the saved note as its why-saved line")
            lk = calls(pg, "lock")
            check(len(lk) == 1 and lk[0].get("lock") is True, f"{w}: Lock locks the saved note")
            check(len(calls(pg, "capture")) == 1, f"{w}: adding the note makes no second note")
            check(pg.is_hidden("#capture") and "Note added and locked" in (pg.text_content("#toast") or ""), f"{w}: the sheet closes and says so")

            pg.click("#new-btn:visible, #lb-new:visible"); pg.wait_for_timeout(200)
            check(pg.text_content("#capture-save") == "Save" and pg.is_visible("label:has(#c-file)"), f"{w}: the + sheet is back to normal afterwards")
            pg.click("#capture-cancel")
            check(not errors, f"{w}: no page errors {errors[:1]}")
            pg.close()

            # A failed save keeps the share on the sheet.
            pg = b.new_page(viewport={"width": w, "height": h})
            errors = []; pg.on("pageerror", lambda e: errors.append(str(e)))
            pg.add_init_script("window.FAIL_CAPTURE = true;" + share)
            pg.goto(url); pg.wait_for_timeout(1000)
            check(pg.is_visible("#capture") and LINK.replace("https://", "") in (pg.text_content("#c-preview") or ""),
                  f"{w}: a failed save opens the sheet with the share")
            check("Not saved yet" in (pg.text_content("#toast") or ""), f"{w}: Keith is told it isn't saved yet")
            check(pg.text_content("#capture-save") == "Save", f"{w}: Save on that sheet makes the note")
            check(not errors, f"{w}: no page errors on a failed save {errors[:1]}")
            pg.close()
        b.close()

    srv.shutdown(); shutil.rmtree(tmp)
    print("\nAll checks passed." if not failures else f"\n{len(failures)} check(s) failed.")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
