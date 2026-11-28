"""Feed smoke test: runs the real app against a fake API in headless Chrome.

Checks the things that have broken before:
  1. cards never move once placed when the next batch loads (the CSS-columns reshuffle),
  2. scrolling keeps loading on a tall desktop screen (the stuck-at-40 bug),
  3. columns stay even, because images are sized before they're placed,
     and no hover overlay is cut off on tiny notes or wide images,
  4. loading stops cleanly at the end of the notes.

Run:  python3 tests/feed_check.py         (needs: pip install playwright, and Chrome or Chromium)
Exit code 0 means all checks passed. No network, no sign-in, no real data.
"""
import functools, http.server, json, os, re, shutil, sys, tempfile, threading, time

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOTAL = 500  # fake notes

# Replaces the Supabase import and fetch: a signed-in session and a feed API over TOTAL fake notes, newest first.
STUB = """
const createClient = () => ({ auth: {
  getSession: async () => ({ data: { session: { access_token: "test" } } }),
  onAuthStateChange: (cb) => setTimeout(() => cb("SIGNED_IN"), 0),
  signInWithOtp: async () => ({}) } });
const FAKE = Array.from({ length: %d }, (_, i) => ({
  id: "00000000-0000-0000-0000-" + String(i).padStart(12, "0"),
  created_at: new Date(Date.UTC(2026, 10, 19) - i * 3600e3).toISOString(),
  format: i %% 2 ? "note" : "bookmark",
  // every 7th note is tiny (one short line, like an email address); every 11th image is a wide banner
  title: i %% 7 === 0 ? null : "Note " + i, excerpt: i %% 7 === 0 ? "simon@blah.biz" : "body ".repeat(5 + (i * 13) %% 40),
  image: i %% 3 === 0 ? "/img/" + (i %% 11 === 0 ? 40 : 150 + (i * 53) %% 450) + ".svg" : null,
  host: i %% 2 ? null : "youtu.be", projects: i %% 5 ? ["Essays", "Lurûn", "Portfolio and job search", "English life trails"] : [] }));
window.CALLS = [];
window.fetch = async (url, o) => {
  const b = JSON.parse(o.body); CALLS.push(b); let r = {};
  if (b.action === "projects") r = { projects: [] };
  else if (b.action === "feed") { let n = b.pinned ? [] : FAKE; if (b.before) n = n.filter((x) => x.created_at < b.before); r = { notes: n.slice(0, b.limit) }; }
  return new Response(JSON.stringify(r), { status: 200 });
};
""" % TOTAL

COUNT = "document.querySelectorAll('#feed .card').length"
POSITIONS = """(() => { const m = {}; document.querySelectorAll('#feed .card').forEach((c) => {
  m[c.dataset.id] = [...c.parentNode.parentNode.children].indexOf(c.parentNode) + ':' + [...c.parentNode.children].indexOf(c); }); return m; })()"""


def chrome():
    for p in ("/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
              "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"):
        if os.path.exists(p):
            return p
    return None  # fall back to Playwright's own Chromium


def main():
    tmp = tempfile.mkdtemp()
    shutil.copytree(os.path.join(ROOT, "app"), tmp, dirs_exist_ok=True)
    js = open(os.path.join(tmp, "app.js")).read()
    js, n = re.subn(r'^import \{ createClient \} from .*$', STUB, js, count=1, flags=re.M)
    assert n == 1, "couldn't find the Supabase import in app.js to replace"
    open(os.path.join(tmp, "app.js"), "w").write(js)

    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a): pass
        def do_GET(self):
            # Fake images arrive slowly, as real ones do, in heights from 150 to 600px.
            m = re.match(r"^/img/(\d+)\.svg", self.path)
            if not m:
                return super().do_GET()
            time.sleep(0.25)
            body = f"<svg xmlns='http://www.w3.org/2000/svg' width='300' height='{m.group(1)}'><rect width='100%' height='100%' fill='#456'/></svg>".encode()
            self.send_response(200); self.send_header("Content-Type", "image/svg+xml"); self.send_header("Content-Length", str(len(body))); self.end_headers()
            try: self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError): pass  # the page closed mid-download
    handler = functools.partial(Quiet, directory=tmp)
    class Server(http.server.ThreadingHTTPServer):
        daemon_threads = True
        def handle_error(self, *a): pass
    srv = Server(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{srv.server_address[1]}/index.html"

    failures = []
    def check(ok, msg):
        print(("PASS " if ok else "FAIL ") + msg)
        if not ok: failures.append(msg)

    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=chrome())
        for w, h in ((1440, 900), (2560, 1400), (400, 850)):
            for run in range(3):  # the stuck-at-40 bug was a race: repeat
                pg = b.new_page(viewport={"width": w, "height": h})
                errors = []
                pg.on("pageerror", lambda e: errors.append(str(e)))
                pg.goto(url); pg.wait_for_timeout(1200)
                before = pg.evaluate(POSITIONS)
                # Phones run the feed bottom-up (older notes load at the top), so scroll the other way there.
                pg.evaluate("scrollTo(0, %s)" % ("0" if w < 700 else "document.body.scrollHeight")); pg.wait_for_timeout(900)
                after = pg.evaluate(POSITIONS)
                moved = sum(1 for k in before if after.get(k) != before[k])
                grew = pg.evaluate(COUNT) > len(before)
                if run == 0 or moved or not grew or errors:
                    check(moved == 0, f"{w}x{h} run {run + 1}: no card moved when the next batch loaded ({moved} moved)")
                    check(grew, f"{w}x{h} run {run + 1}: scrolling to the end loaded more ({len(before)} -> {pg.evaluate(COUNT)})")
                    check(not errors, f"{w}x{h} run {run + 1}: no page errors {errors[:1]}")
                pg.close()

        # Columns stay even: images are sized before they're placed, so no column runs far ahead.
        for w, h in ((1440, 900), (400, 850)):
            pg = b.new_page(viewport={"width": w, "height": h})
            pg.goto(url); pg.wait_for_timeout(2500)
            heights = pg.evaluate("[...document.querySelectorAll('#feed > .col')].map((c) => c.offsetHeight)")
            unsized = pg.evaluate("[...document.querySelectorAll('#feed .c-media img')].filter((i) => !i.style.aspectRatio).length")
            spread = max(heights) - min(heights)
            check(spread < 400, f"{w}x{h}: columns end within 400px of each other ({spread}px, {heights})")
            check(unsized == 0, f"{w}x{h}: every image had its size reserved before placing ({unsized} not)")
            clipped = pg.evaluate("""[...document.querySelectorAll('#feed .hover')].filter((o) => {
              const box = o.getBoundingClientRect(), pad = parseFloat(getComputedStyle(o).paddingTop);
              return [...o.children].some((c) => { const r = c.getBoundingClientRect();
                return r.top < box.top + pad - 1 || r.right > box.right + 1; }); }).length""")
            check(clipped == 0, f"{w}x{h}: no hover overlay is cut off, even on tiny notes and wide images ({clipped} cut off)")
            pg.close()

        pg = b.new_page(viewport={"width": 2560, "height": 1400})
        pg.goto(url); pg.wait_for_timeout(1200)
        for _ in range(30):
            pg.evaluate("scrollTo(0, document.body.scrollHeight)"); pg.wait_for_timeout(500)
        n = pg.evaluate(COUNT)
        calls = pg.evaluate("CALLS.filter((c) => c.action === 'feed' && !c.pinned).length")
        check(n == TOTAL, f"all {TOTAL} notes load by scrolling ({n})")
        check(calls <= TOTAL // 40 + 2, f"loading stops at the end ({calls} feed calls)")
        b.close()

    srv.shutdown(); shutil.rmtree(tmp)
    print("\nAll checks passed." if not failures else f"\n{len(failures)} check(s) failed.")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
