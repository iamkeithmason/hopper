"""Capture smoke test: adding images to a new note (Image button, paste, drag and drop, remove, the four-image cap).

Runs the real app against a fake API in headless Chrome, like feed_check.py.
Run:  python3 tests/capture_check.py         (needs: pip install playwright, and Chrome or Chromium)
Exit code 0 means all checks passed. No network, no sign-in, no real data.
"""
import base64, functools, http.server, os, re, shutil, sys, tempfile, threading, zlib, struct

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.environ.get("CAPTURE_SHOTS")  # optional folder for screenshots of the sheet

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
  else if (b.action === "capture") r = { saved: { id: "x" }, filed: [] };
  return new Response(JSON.stringify(r), { status: 200 });
};
"""

# Paste or drop an image built on a canvas, as the clipboard holds a screenshot.
MAKE = """async (w) => { const c = document.createElement('canvas'); c.width = w; c.height = 300;
  const g = c.getContext('2d'); g.fillStyle = '#4a6'; g.fillRect(0, 0, w, 300);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const dt = new DataTransfer(); dt.items.add(new File([blob], 'shot.png', { type: 'image/png' })); return dt; }"""


def png(w, h):
    raw = b"".join(b"\x00" + b"\x22\x44\x88" * w for _ in range(h))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


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
    for i, w in enumerate((800, 400, 600)):
        open(os.path.join(tmp, f"pic{i}.png"), "wb").write(png(w, 300))

    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a): pass
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=tmp))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{srv.server_address[1]}/index.html"

    failures = []
    def check(ok, msg):
        print(("PASS " if ok else "FAIL ") + msg)
        if not ok: failures.append(msg)

    thumbs = "document.querySelectorAll('#c-preview .p-thumb').length"
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=chrome())
        for w, h in ((1440, 900), (400, 850)):
            pg = b.new_page(viewport={"width": w, "height": h})
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            pg.goto(url); pg.wait_for_timeout(800)
            pg.click("#new-btn"); pg.wait_for_timeout(200)
            check(pg.is_hidden("#c-preview"), f"{w}: a new note opens with no preview")
            check(pg.is_visible("label:has(#c-file)"), f"{w}: the Image button shows on the sheet")

            pg.set_input_files("#c-file", [os.path.join(tmp, "pic0.png"), os.path.join(tmp, "pic1.png")])
            pg.wait_for_timeout(200)
            check(pg.evaluate(thumbs) == 2 and pg.is_visible("#c-preview"), f"{w}: two picked images show as thumbnails ({pg.evaluate(thumbs)})")

            pg.evaluate(f"(async () => {{ const dt = await ({MAKE})(500); document.getElementById('c-note').dispatchEvent(new ClipboardEvent('paste', {{ clipboardData: dt, bubbles: true, cancelable: true }})); }})()")
            pg.wait_for_timeout(300)
            check(pg.evaluate(thumbs) == 3, f"{w}: a pasted screenshot is added ({pg.evaluate(thumbs)})")

            pg.evaluate(f"(async () => {{ const dt = await ({MAKE})(300); document.getElementById('capture-form').dispatchEvent(new DragEvent('drop', {{ dataTransfer: dt, bubbles: true, cancelable: true }})); }})()")
            pg.wait_for_timeout(300)
            check(pg.evaluate(thumbs) == 4, f"{w}: a dropped image is added ({pg.evaluate(thumbs)})")

            pg.set_input_files("#c-file", [os.path.join(tmp, "pic2.png")]); pg.wait_for_timeout(200)
            check(pg.evaluate(thumbs) == 4, f"{w}: a fifth image is refused ({pg.evaluate(thumbs)})")
            check("Up to 4" in (pg.text_content("#toast") or ""), f"{w}: Keith is told about the four-image limit")

            if SHOTS: pg.screenshot(path=os.path.join(SHOTS, f"capture-{w}.png"))
            pg.click("#c-preview .p-thumb:nth-child(2) .p-drop"); pg.wait_for_timeout(150)
            check(pg.evaluate(thumbs) == 3, f"{w}: the ✕ removes an image ({pg.evaluate(thumbs)})")

            pg.fill("#c-note", "Pricing table, full screen")
            pg.click("#capture-save"); pg.wait_for_timeout(800)
            cap = pg.evaluate("CALLS.filter((c) => c.action === 'capture')")
            check(len(cap) == 1, f"{w}: one capture call ({len(cap)})")
            if cap:
                c = cap[0]
                check(len(c.get("images", [])) == 3, f"{w}: three images sent ({len(c.get('images', []))})")
                check(c.get("text") == "Pricing table, full screen" and c.get("note") == "", f"{w}: the typed note is the note's body")
                ok = all(base64.b64decode(i["data"])[:2] == b"\xff\xd8" and i["width"] > 0 for i in c.get("images", []))
                check(ok, f"{w}: images are sent as shrunk JPEGs with sizes")
            check(pg.is_hidden("#capture"), f"{w}: the sheet closes after saving")

            pg.click("#new-btn"); pg.wait_for_timeout(200)
            check(pg.evaluate(thumbs) == 0, f"{w}: the next new note starts with no images")
            pg.set_input_files("#c-file", [os.path.join(tmp, "pic0.png")]); pg.wait_for_timeout(200)
            pg.click("#capture-save"); pg.wait_for_timeout(800)
            last = pg.evaluate("CALLS.filter((c) => c.action === 'capture').pop()")
            check(len(last.get("images", [])) == 1 and not last.get("text"), f"{w}: an image on its own can be saved")
            check(not errors, f"{w}: no page errors {errors[:1]}")
            pg.close()
        b.close()

    srv.shutdown(); shutil.rmtree(tmp)
    print("\nAll checks passed." if not failures else f"\n{len(failures)} check(s) failed.")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
