"""Video summary check (HOP-61): an open video note shows "What the video says" with its summary and key points,
and a video without a summary shows none. Runs the real app against a fake API in headless Chrome, like overflow_check.py.
Run:  python3 tests/video_summary_check.py      (needs: pip install playwright, and Chrome or Chromium)
"""
import functools, http.server, json, os, re, shutil, sys, tempfile, threading

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.environ.get("VIDEO_SHOTS")
SUMMARY = ("Lagos walks through rebuilding a design system around tokens, arguing teams should name decisions, not colours.\n\n"
           "- Name tokens for their job, such as surface-raised, not grey-100\n- Ship the token file before any components\n"
           "- Audit with a screenshot wall of every button in production")
def note(i, summary):
    return {"id": f"{i}1111111-1111-1111-1111-111111111111", "locked": False, "title": "Design tokens talk", "body": None,
            "format": "bookmark", "created_at": "2026-11-19T20:00:00Z", "tags": [], "images": [],
            "links": [{"url": "https://www.youtube.com/watch?v=abcdefghijk", "page_title": "Design tokens talk", "kind": "video",
                       "page_text": "Video by Someone", "transcript_summary": summary, "has_transcript": bool(summary)}]}
NOTES = {n["id"]: n for n in (note(1, SUMMARY), note(2, None))}

STUB = """
const createClient = () => ({ auth: {
  getSession: async () => ({ data: { session: { access_token: "test" } } }),
  onAuthStateChange: (cb) => setTimeout(() => cb("SIGNED_IN"), 0),
  signInWithOtp: async () => ({}) } });
window.fetch = async (url, o) => {
  const b = JSON.parse(o.body); let r = {};
  if (b.action === "projects") r = { projects: [] };
  else if (b.action === "feed") r = { notes: [] };
  else if (b.action === "note") r = { note: NOTES[b.id], related: [] };
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
    stub = f"const NOTES = {json.dumps(NOTES)};\n" + STUB
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

    with sync_playwright() as p:
        exe = chrome()
        b = p.chromium.launch(**({"executable_path": exe} if exe else {}))
        for w, h in ((390, 844), (1440, 900)):
            for nid, n in NOTES.items():
                has = bool(n["links"][0]["transcript_summary"])
                pg = b.new_page(viewport={"width": w, "height": h})
                pg.route("**/www.youtube-nocookie.com/**", lambda r: r.fulfill(body=""))
                pg.route("**/www.youtube.com/**", lambda r: r.fulfill(body=""))
                errors = []; pg.on("pageerror", lambda e: errors.append(str(e)))
                pg.add_init_script(f"history.replaceState(null, '', '/n/{nid}')")
                pg.goto(url); pg.wait_for_timeout(900)
                check(pg.is_visible("#detail"), f"{w}: the note opens")
                block = pg.locator(".from-page .v-summary")
                if has:
                    check(block.count() == 1 and "what the video says" in block.inner_text().lower(), f"{w}: the summary block shows")
                    check(pg.locator(".v-summary li").count() == 3, f"{w}: three key points as a list")
                    check(block.locator("p").nth(1).inner_text().startswith("Lagos walks"), f"{w}: the lead paragraph comes first")
                    check("null" not in block.inner_text(), f"{w}: no stray 'null' text")
                    if SHOTS: pg.screenshot(path=os.path.join(SHOTS, f"video-summary-{w}.png"))
                else:
                    check(block.count() == 0, f"{w}: no summary block on a video without one")
                check(pg.evaluate(wide) <= 0, f"{w}: the page doesn't widen ({pg.evaluate(wide)}px)")
                check(not errors, f"{w}: no page errors {errors[:1]}")
                pg.close()
        b.close()

    srv.shutdown(); shutil.rmtree(tmp)
    print("\nAll checks passed." if not failures else f"\n{len(failures)} check(s) failed.")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
