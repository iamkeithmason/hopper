"""Flipped phone feed (trial): below 700px the board runs bottom-up, like a chat.

Runs the real app against the fake API from feed_check.py in headless Chrome and checks:
  1. a phone opens scrolled to the bottom, with the newest note bottom left, just above the bar,
  2. older notes load at the top as you scroll up, and the cards on screen don't jump while they do,
  3. skeleton cards show at the top of the columns while a batch loads,
  4. scrolling all the way up reaches every note, and loading stops at the end,
  5. desktop is unchanged: newest top left, the page opens at the top.

Run:  python3 tests/flip_check.py         (needs: pip install playwright, and Chrome or Chromium)
"""
import functools, http.server, os, re, shutil, sys, tempfile, threading

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from feed_check import STUB, TOTAL, COUNT, chrome  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NEWEST = "00000000-0000-0000-0000-000000000000"
# Where each card on screen is, by id, relative to the viewport.
ON_SCREEN = """(() => { const m = {}; document.querySelectorAll('#feed .card').forEach((c) => { const r = c.getBoundingClientRect();
  if (r.bottom > 0 && r.top < innerHeight) m[c.dataset.id] = Math.round(r.top); }); return m; })()"""
# Older batches take 800ms to arrive.
SLOW_OLDER = """(() => { const f = window.fetch; window.fetch = async (u, o) => { if (JSON.parse(o.body).before) await new Promise((r) => setTimeout(r, 800)); return f(u, o); }; })()"""
FROM_BOTTOM = "Math.round(document.scrollingElement.scrollHeight - scrollY - innerHeight)"


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
            m = re.match(r"^/img/(\d+)\.svg", self.path)
            if not m:
                return super().do_GET()
            body = f"<svg xmlns='http://www.w3.org/2000/svg' width='300' height='{m.group(1)}'><rect width='100%' height='100%' fill='#456'/></svg>".encode()
            self.send_response(200); self.send_header("Content-Type", "image/svg+xml"); self.send_header("Content-Length", str(len(body))); self.end_headers()
            try: self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError): pass
    class Server(http.server.ThreadingHTTPServer):
        daemon_threads = True
        def handle_error(self, *a): pass
    srv = Server(("127.0.0.1", 0), functools.partial(Quiet, directory=tmp))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{srv.server_address[1]}/index.html"

    failures = []
    def check(ok, msg):
        print(("PASS " if ok else "FAIL ") + msg)
        if not ok: failures.append(msg)

    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=chrome())
        for w, h in ((390, 844), (412, 915)):
            pg = b.new_page(viewport={"width": w, "height": h})
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            pg.goto(url); pg.wait_for_timeout(1500)
            check(pg.evaluate(FROM_BOTTOM) <= 2, f"{w}x{h}: opens scrolled to the bottom ({pg.evaluate(FROM_BOTTOM)}px from it)")
            spot = pg.evaluate(f"""(() => {{ const c = document.querySelector('#feed .card[data-id="{NEWEST}"]'), r = c.getBoundingClientRect(),
              bar = document.querySelector('#lbar').getBoundingClientRect(), cards = [...document.querySelectorAll('#feed .card')].map((x) => x.getBoundingClientRect());
              return {{ left: r.left <= Math.min(...cards.map((x) => x.left)) + 1, lowest: r.bottom >= Math.max(...cards.map((x) => x.bottom)) - 1,
                gap: Math.round(bar.top - r.bottom) }}; }})()""")
            check(spot["left"] and spot["lowest"], f"{w}x{h}: the newest note is bottom left ({spot})")
            check(0 <= spot["gap"] <= 120, f"{w}x{h}: the newest note sits just above the bar ({spot['gap']}px gap)")

            # Scroll up step by step; each time more notes load above, what's on screen must stay put. Older batches
            # are slowed down, so the skeletons arrive first and the cards later, each a chance to jump.
            pg.evaluate(SLOW_OLDER)
            jumps, loads = [], 0
            for _ in range(12):
                pg.evaluate("scrollBy(0, -600)"); pg.wait_for_timeout(100)
                seen, n0 = pg.evaluate(ON_SCREEN), pg.evaluate(COUNT)
                pg.wait_for_timeout(1300)
                now, n1 = pg.evaluate(ON_SCREEN), pg.evaluate(COUNT)
                if n1 > n0:
                    loads += 1
                    jumps += [abs(now[k] - seen[k]) for k in seen if k in now and abs(now[k] - seen[k]) > 2]
            check(loads >= 1, f"{w}x{h}: scrolling up loaded older notes at the top ({loads} batches)")
            check(not jumps, f"{w}x{h}: cards on screen stayed put while older notes loaded above ({len(jumps)} moved, up to {max(jumps or [0])}px)")
            check(not errors, f"{w}x{h}: no page errors {errors[:1]}")
            pg.close()

        # Skeletons: while a batch is on its way they sit at the top of each column, above the cards.
        pg = b.new_page(viewport={"width": 390, "height": 844})
        pg.goto(url); pg.wait_for_timeout(1500)
        pg.evaluate(SLOW_OLDER)
        pg.evaluate("scrollTo(0, 0)"); pg.wait_for_timeout(300)
        sk = pg.evaluate("""[...document.querySelectorAll('#feed > .col')].map((col) => { const s = col.querySelector('.skel'), c = col.querySelector('.card');
          return !!s && (!c || s.getBoundingClientRect().bottom <= c.getBoundingClientRect().top + 1); })""")
        check(all(sk) and sk, f"390x844: skeleton cards show at the top of every column while older notes load ({sk})")
        pg.wait_for_timeout(1200)
        check(pg.evaluate("document.querySelectorAll('#feed .skel').length") == 0, "390x844: skeletons go once the batch lands")
        pg.close()

        # All the way up: every note arrives, and loading stops.
        pg = b.new_page(viewport={"width": 390, "height": 844})
        pg.goto(url); pg.wait_for_timeout(1200)
        for _ in range(40):
            pg.evaluate("scrollTo(0, 0)"); pg.wait_for_timeout(400)
        n = pg.evaluate(COUNT)
        calls = pg.evaluate("CALLS.filter((c) => c.action === 'feed' && !c.pinned).length")
        check(n == TOTAL, f"390x844: all {TOTAL} notes load by scrolling up ({n})")
        check(calls <= TOTAL // 40 + 2, f"390x844: loading stops at the end ({calls} feed calls)")
        oldest_top = pg.evaluate("""(() => { const last = '00000000-0000-0000-0000-' + String(%d).padStart(12, '0');
          const r = document.querySelector(`#feed .card[data-id="${last}"]`).getBoundingClientRect(); return Math.round(r.top + scrollY); })()""" % (TOTAL - 1))
        check(oldest_top < 3000, f"390x844: the oldest note is near the top of the page ({oldest_top}px down)")
        pg.close()

        # Desktop: unchanged.
        pg = b.new_page(viewport={"width": 1440, "height": 900})
        pg.goto(url); pg.wait_for_timeout(1500)
        top = pg.evaluate(f"""(() => {{ const r = document.querySelector('#feed .card[data-id="{NEWEST}"]').getBoundingClientRect();
          const cards = [...document.querySelectorAll('#feed .card')].map((x) => x.getBoundingClientRect());
          return {{ y: scrollY, left: r.left <= Math.min(...cards.map((x) => x.left)) + 1, top: r.top <= Math.min(...cards.map((x) => x.top)) + 1 }}; }})()""")
        check(top["y"] == 0 and top["left"] and top["top"], f"1440x900: desktop unchanged, newest top left and the page opens at the top ({top})")
        pg.close()
        b.close()

    srv.shutdown(); shutil.rmtree(tmp)
    print("\nAll checks passed." if not failures else f"\n{len(failures)} check(s) failed.")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
