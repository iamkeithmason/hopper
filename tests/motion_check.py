"""Motion check: skeleton cards while the board loads, a tapped card expanding into the note view, and pinching an
image in a note.

Runs the real app against a slow fake API in headless Chrome at phone size, with touch:
- while the first batch loads the board shows skeleton cards in its columns, and no real cards; once the batch is
  placed the skeletons are gone; a note shows skeleton lines (and the tapped card's picture) while it loads
- tapping a card on the board starts a view transition, and when it ends no element keeps a view-transition-name,
  the note is open with the card's picture at the top; back plays it in reverse and the note closes
- two fingers on a note's image zoom it about the point between them and it stays zoomed, clipped to its box; one
  finger drags it, never pulling the sheet down; a double tap settles it back to fit
- with reduced motion there is no view transition and no shimmer; the note still opens and closes
Run:  python3 tests/motion_check.py      (SHOTS=dir to save screenshots, including one mid-expand)
"""
import base64, functools, http.server, os, re, shutil, sys, tempfile, threading

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tests"))
from phone_nav_check import chrome  # noqa: E402

SHOTS = os.environ.get("SHOTS")
# a 4x3 two-colour PNG stands in for a picture
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAAhGgMBXQ0WgQAAAABJRU5ErkJggg==")

STUB = """
const createClient = () => ({ auth: {
  getSession: async () => ({ data: { session: { access_token: "test" } } }),
  onAuthStateChange: (cb) => setTimeout(() => cb("SIGNED_IN"), 0),
  signInWithOtp: async () => ({}) } });
const fakeCard = (i) => ({ id: "0000000" + i + "-0000-0000-0000-000000000000", locked: false, title: "Note " + i, excerpt: "Some words", format: "note", created_at: "2026-11-2" + i + "T20:00:00Z", projects: [], image: i % 2 ? "/pic.png" : null });
window.VT = 0;
if (document.startViewTransition) { const s = document.startViewTransition.bind(document); document.startViewTransition = (f) => { window.VT++; return s(f); }; }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
window.fetch = async (url, o) => {
  const b = JSON.parse(o.body); let r = {};
  if (b.action === "projects") r = { projects: [] };
  else if (b.action === "feed") { if (!b.pinned) await wait(700); r = { notes: b.pinned || b.before ? [] : [1, 2, 3, 4, 5, 6].map(fakeCard) }; }
  else if (b.action === "note") { await wait(500); r = { note: { id: b.id, locked: false, title: "Note 1", body: "Body", format: "note", created_at: "2026-11-21T20:00:00Z", tags: [], images: [{ id: "i1", url: "/pic.png" }], links: [] }, related: [] }; }
  return new Response(JSON.stringify(r), { status: 200 });
};
"""

NAMED = "() => [...document.querySelectorAll('*')].filter((e) => e.style.viewTransitionName).length"


def main():
    tmp = tempfile.mkdtemp()
    shutil.copytree(os.path.join(ROOT, "app"), tmp, dirs_exist_ok=True)
    open(os.path.join(tmp, "pic.png"), "wb").write(PNG)
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
    def shot(pg, name):
        if SHOTS: pg.screenshot(path=os.path.join(SHOTS, f"motion-{name}.png"))
    count = lambda pg, sel: pg.eval_on_selector_all(sel, "(e) => e.length")

    with sync_playwright() as p:
        exe = chrome()
        b = p.chromium.launch(**({"executable_path": exe} if exe else {}))
        for motion in ("no-preference", "reduce"):
            tag = "motion" if motion == "no-preference" else "reduced motion"
            ctx = b.new_context(viewport={"width": 412, "height": 892}, has_touch=True, is_mobile=True, reduced_motion=motion)
            pg = ctx.new_page()
            errors = []; pg.on("pageerror", lambda e: errors.append(str(e)))
            pg.goto(url); pg.wait_for_timeout(350)
            sk, cards = count(pg, "#feed .skel"), count(pg, "#feed .card")
            check(sk >= 6 and cards == 0, f"{tag}: skeleton cards fill the columns while the board loads ({sk} skeletons, {cards} cards)")
            anim = pg.eval_on_selector("#feed .skel .sk-line", "(e) => getComputedStyle(e).animationName")
            check((anim == "sk-shimmer") == (motion == "no-preference"), f"{tag}: shimmer {'runs' if motion == 'no-preference' else 'is off'} ({anim})")
            shot(pg, f"skeleton-{motion}")
            pg.wait_for_timeout(900)
            check(count(pg, "#feed .skel") == 0 and count(pg, "#feed .card") == 6, f"{tag}: skeletons give way to the cards")
            check(pg.get_attribute("#feed", "aria-busy") is None, f"{tag}: the board is no longer marked busy")

            vt0 = pg.evaluate("window.VT")
            pg.tap("#feed .card.has-media"); pg.wait_for_timeout(120)
            shot(pg, f"expand-mid-{motion}")
            check(count(pg, "#d-body .d-skel .sk-line") >= 3, f"{tag}: the note shows skeleton lines while it loads")
            check(count(pg, "#d-body .d-images img") == 1, f"{tag}: the tapped card's picture is already at the top of the note")
            pg.wait_for_timeout(900)
            want = 1 if motion == "no-preference" else 0
            check(pg.evaluate("window.VT") - vt0 == want, f"{tag}: tapping a card {'expands it with a view transition' if want else 'opens without a view transition'}")
            check(pg.is_visible("#detail") and count(pg, "#d-body .d-skel") == 0 and pg.is_visible("#d-body textarea.title"), f"{tag}: the note is open and loaded")
            check(pg.evaluate(NAMED) == 0, f"{tag}: no element keeps a view-transition-name after the expand")
            check(not pg.evaluate("document.documentElement.classList.contains('morphing')"), f"{tag}: the morphing class is cleared")
            shot(pg, f"note-{motion}")

            # pinch: two fingers start close together on the picture and spread apart
            box = pg.locator("#d-body .d-images img").bounding_box()
            cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
            cdp = ctx.new_cdp_session(pg)
            pts = lambda d: [{"x": cx - d, "y": cy, "id": 1}, {"x": cx + d, "y": cy, "id": 2}]
            cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": pts(20)})
            for d in (30, 45, 60):
                cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": pts(d)})
            tf = pg.eval_on_selector("#d-body .d-images img", "(e) => e.style.transform")
            sc = float(re.search(r"scale\(([\d.]+)\)", tf or "scale(1)").group(1))
            check(2.8 < sc < 3.2, f"{tag}: spreading two fingers scales the picture (scale {sc})")
            check(pg.is_visible("#detail") and not pg.eval_on_selector("#d-sheet", "(e) => e.style.transform"), f"{tag}: the pinch doesn't pull the sheet down")
            cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
            pg.wait_for_timeout(300)
            TF = "(e) => e.style.transform"
            tf1 = pg.eval_on_selector("#d-body .d-images img", TF)
            check("scale(" in (tf1 or "") and pg.eval_on_selector("#d-body .d-images img", "(e) => e.classList.contains('zoomed')"), f"{tag}: the picture stays zoomed when the fingers lift ({tf1})")
            vis = pg.eval_on_selector("#d-body .d-images img", "(e) => { const r = e.getBoundingClientRect(), c = e.style.clipPath; return !!c && c.startsWith('inset'); }")
            check(vis, f"{tag}: the zoomed picture is clipped to its own box")
            # one finger drags it around
            cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": cx, "y": cy, "id": 3}]})
            for k in (10, 25, 40):
                cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": cx + k, "y": cy + k, "id": 3}]})
            cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
            tf2 = pg.eval_on_selector("#d-body .d-images img", TF)
            check(tf2 != tf1 and "scale(" in (tf2 or ""), f"{tag}: one finger drags the zoomed picture ({tf2})")
            check(pg.is_visible("#detail") and not pg.eval_on_selector("#d-sheet", "(e) => e.style.transform"), f"{tag}: dragging a zoomed picture doesn't pull the sheet down")
            for _ in range(2):  # double tap
                cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": cx, "y": cy, "id": 4}]})
                cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
                pg.wait_for_timeout(80)
            pg.wait_for_timeout(400)
            check(not pg.eval_on_selector("#d-body .d-images img", "(e) => e.style.transform || e.classList.contains('zoomed')"), f"{tag}: a double tap settles it back to fit")

            vt0 = pg.evaluate("window.VT")
            pg.tap("#d-back"); pg.wait_for_timeout(700)
            check(pg.is_hidden("#detail"), f"{tag}: back closes the note")
            check(pg.evaluate("window.VT") - vt0 == want, f"{tag}: closing {'shrinks back into the card' if want else 'needs no view transition'}")
            check(pg.evaluate(NAMED) == 0, f"{tag}: no element keeps a view-transition-name after closing")
            check(not errors, f"{tag}: no script errors ({errors})")
            ctx.close()
        b.close()
    srv.shutdown()
    print("\nall passed" if not failures else f"\n{len(failures)} failed")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
