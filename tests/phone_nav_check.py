"""Phone navigation (HOP-39, option C "one bar"): below 700px the controls sit at the bottom for a left thumb.

Checks the bar replaces the top header, the sheet grows upward from its search field (All notes lowest, Archived
and Bin above the projects), picking a project shows its topics as chips above the bar, a topic is one tap from
there, search from the sheet runs and shows on the bar, and the note view and capture sheet put back and Save
bottom left. Desktop keeps the top header. Runs the real app against a fake API in headless Chrome.
Run:  python3 tests/phone_nav_check.py      (SHOTS=dir to save screenshots)
"""
import functools, http.server, os, re, shutil, sys, tempfile, threading

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.environ.get("SHOTS")

STUB = """
const createClient = () => ({ auth: {
  getSession: async () => ({ data: { session: { access_token: "test" } } }),
  onAuthStateChange: (cb) => setTimeout(() => cb("SIGNED_IN"), 0),
  signInWithOtp: async () => ({}) } });
const PROJECTS = [["a", "Alpha", true], ["b", "Beta"], ["c", "Coracle"]].map(([id, name, pinned]) => ({ id, name, notes: 12, last_activity: "2026-11-25", pinned: !!pinned }));
const fakeCard = (i, extra = {}) => ({ id: "0000000" + i + "-0000-0000-0000-000000000000", locked: false, title: "Note " + i, excerpt: "Some words for note " + i, format: "note", created_at: "2026-11-2" + i + "T20:00:00Z", projects: [], image: null, ...extra });
window.CALLS = [];
window.fetch = async (url, o) => {
  const b = JSON.parse(o.body); let r = {}; window.CALLS.push(b);
  if (b.action === "projects") r = { projects: PROJECTS };
  else if (b.action === "topics") r = { topics: b.project_id === "a" ? [{ name: "Lore" }, { name: "Names" }] : [] };
  else if (b.action === "feed") r = { notes: b.pinned || b.before ? [] : [1, 2, 3, 4].map((i) => fakeCard(i)) };
  else if (b.action === "search") r = { notes: [fakeCard(5, { title: "Found " + b.q })] };
  else if (b.action === "note") r = { note: { id: b.id, locked: false, title: "Note 1", body: "Body", format: "note", created_at: "2026-11-21T20:00:00Z", tags: [], images: [], links: [] }, related: [] };
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
    def shot(pg, name):
        if SHOTS: pg.screenshot(path=os.path.join(SHOTS, f"phone-nav-{name}.png"))
    box = lambda pg, sel: pg.locator(sel).bounding_box()

    with sync_playwright() as p:
        exe = chrome()
        b = p.chromium.launch(**({"executable_path": exe} if exe else {}))
        W, H = 412, 892
        pg = b.new_page(viewport={"width": W, "height": H}, has_touch=True, is_mobile=True)
        errors = []; pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(url); pg.wait_for_timeout(800)
        check(pg.is_hidden("header#top") and pg.is_visible("#lbar"), "the bottom bar replaces the top header")
        nb, ob = box(pg, "#lb-new"), box(pg, "#lb-open")
        check(nb["x"] >= 16 and nb["x"] < ob["x"] and nb["y"] > H * 0.85, f"New sits bottom left, at least 16px from the edge ({nb})")
        check(pg.text_content("#lb-where") == "All notes", "the bar says where you are")
        shot(pg, "home")

        pg.tap("#lb-open"); pg.wait_for_timeout(200)
        rows = pg.eval_on_selector_all("#ns-list .ns-row", "(r) => r.map((x) => x.querySelector('.ns-name').textContent)")
        check(rows[-1] == "All notes" and rows[-2] == "Alpha" and rows.index("Archived") < rows.index("Coracle"),
              f"the sheet grows upward: All notes lowest, then the first project; views at the top ({rows})")
        check(box(pg, "#ns-q")["y"] > box(pg, "#ns-list")["y"], "the search field sits below the list")
        check(pg.is_hidden("#lb-topics"), "no topic row outside a project")
        shot(pg, "sheet")

        pg.tap("#ns-list .ns-row:has-text('Alpha')"); pg.wait_for_timeout(400)
        check(pg.is_hidden("#nav-sheet") and pg.text_content("#lb-where") == "Alpha", "picking a project closes the sheet and the bar says Alpha")
        chips = pg.eval_on_selector_all("#lb-topics button", "(c) => c.map((x) => x.textContent)")
        check(pg.is_visible("#lb-topics") and chips == ["All topics", "Lore", "Names"], f"its topics show above the bar ({chips})")
        check(box(pg, "#lb-topics")["y"] < box(pg, "#lb-open")["y"], "the topic row sits just above the bar")
        shot(pg, "project")
        pg.tap("#lb-topics button:has-text('Lore')"); pg.wait_for_timeout(400)
        check(pg.text_content("#lb-where") == "Alpha · Lore", "one tap on a topic filters, and the bar says so")
        feed = [c for c in pg.evaluate("CALLS") if c.get("action") == "feed"]
        check(feed and feed[-1].get("topic") == "Lore" and feed[-1].get("project_id") == "a", "the feed asks for Alpha · Lore")
        pg.tap("#lb-open"); pg.wait_for_timeout(200)
        check(pg.is_visible("#ns-list .ns-chips button.on:has-text('Lore')"), "the topics are in the sheet too, with Lore on")

        pg.fill("#ns-q", "coracle"); pg.wait_for_timeout(150)
        rows = pg.eval_on_selector_all("#ns-list .ns-row", "(r) => r.map((x) => x.querySelector('.ns-name').textContent)")
        check(rows == ["Coracle", "Search notes for “coracle”"], f"typing narrows the list and offers a search nearest the thumb ({rows})")
        pg.fill("#ns-q", "river crossing"); pg.press("#ns-q", "Enter"); pg.wait_for_timeout(500)
        check(pg.is_hidden("#nav-sheet") and "river crossing" in pg.text_content("#lb-hint") and pg.text_content("#lb-where") == "All notes",
              "search runs over every note and shows on the bar")
        check(pg.is_hidden("#lb-topics"), "the topic row hides during a search")
        check("Found river crossing" in pg.text_content("#feed"), "search results fill the feed")
        pg.tap("#lb-open"); pg.wait_for_timeout(200)
        pg.tap("#ns-list .ns-row:has-text('Clear search')"); pg.wait_for_timeout(400)
        check("Search, projects" in pg.text_content("#lb-hint"), "Clear search empties the bar")

        pg.tap("#lb-open"); pg.wait_for_timeout(200)
        pg.tap("#ns-list .ns-row:has-text('Archived')"); pg.wait_for_timeout(400)
        check(pg.text_content("#lb-where") == "Archived", "Archived opens from the sheet and the bar says so")
        pg.tap("#lb-open"); pg.wait_for_timeout(200)
        pg.tap("#ns-list .ns-row:has-text('All notes')"); pg.wait_for_timeout(400)
        check(pg.text_content("#lb-where") == "All notes" and pg.is_hidden("#view-banner"), "All notes leaves Archived")

        pg.tap(".card"); pg.wait_for_timeout(600)
        bb = box(pg, "#d-back")
        check(pg.is_visible("#detail") and pg.is_hidden(".editor-bar") and bb and bb["x"] < W * 0.2 and bb["y"] > H * 0.85,
              f"the note's back button sits bottom left ({bb})")
        pg.tap("#d-more2"); pg.wait_for_timeout(150)
        items = pg.eval_on_selector_all("#d-menu button:not([hidden])", "(b) => b.map((x) => [x.textContent, x.getBoundingClientRect().y])")
        ys = {t: y for t, y in items}
        check(ys.get("Move to Bin", 0) < ys.get("Open original link", 0) or "Open original link" not in ys,
              f"the note menu opens upward with Move to Bin furthest away ({items})")
        shot(pg, "note")
        pg.tap("#d-back"); pg.wait_for_timeout(400)
        check(pg.is_hidden("#detail"), "back closes the note")

        pg.tap("#lb-new"); pg.wait_for_timeout(200)
        sb, cb = box(pg, "#capture-save"), box(pg, "#capture-cancel")
        check(sb["x"] < cb["x"] and sb["x"] < W * 0.3, f"Save is the left-most button in capture, Cancel the right ({sb['x']}, {cb['x']})")
        shot(pg, "capture")
        check(not errors, f"no script errors ({errors[:2]})")

        d = b.new_page(viewport={"width": 1440, "height": 900})
        d.goto(url); d.wait_for_timeout(800)
        check(d.is_visible("header#top") and d.is_hidden("#lbar") and d.is_hidden("#d-back"), "desktop keeps the top header")
        b.close()
    srv.shutdown()
    print(f"\n{len(failures)} failed" if failures else "\nall passed")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
