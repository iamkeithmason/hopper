"""Sign-in check: the sign-in screen explains what went wrong instead of misleading or going blank.

Runs the real app against a fake Supabase client in headless Chrome, like share_check.py, and checks:
- an expired or used link (?error_code=otp_expired) shows the sign-in screen with a reason, and clears the address;
- a sign-in email refused for the rate limit says so plainly, and the link goes back to the app's root;
- a dead session (the API answers 401 and Auth no longer knows the session) returns to sign-in with "You were
  signed out", not "This account isn't Hopper's owner", and signs out this device only;
- a live session that isn't the owner still gets the owner message;
- Sign out signs out this device only (scope "local"), so the phone and the claude.ai connector stay signed in;
- the 6-digit code from the email signs in (verifyOtp, type "email"), and a wrong or old code says so;
- getSession throwing still shows the sign-in screen, never a blank page.
Run:  python3 tests/signin_check.py         (needs: pip install playwright, and Chrome or Chromium)
"""
import functools, http.server, os, re, shutil, sys, tempfile, threading

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

STUB = """
window.AUTH = [];
const SB = () => window.SB || {};
const createClient = () => ({ auth: {
  getSession: async () => {
    if (SB().throwSession) throw new Error("boom");
    return { data: { session: SB().session ? { access_token: "test" } : null } };
  },
  getUser: async () => (SB().deadSession ? { data: { user: null }, error: { status: 403, message: "Session not found" } }
                                         : { data: { user: { email: "other@example.com" } }, error: null }),
  onAuthStateChange: (cb) => { window.AUTHCB = cb; if (SB().session) setTimeout(() => cb("SIGNED_IN"), 0); },
  signInWithOtp: async (a) => { AUTH.push({ otp: a }); return SB().rateLimited ? { error: { status: 429, message: "email rate limit exceeded" } } : {}; },
  verifyOtp: async (a) => { AUTH.push({ verify: a });
    if (a.token === "123456") { SB().session = true; setTimeout(() => window.AUTHCB && AUTHCB("SIGNED_IN"), 0); return { data: {}, error: null }; }
    return { data: {}, error: { status: 403, message: "Token has expired or is invalid" } }; },
  signOut: async (o) => { AUTH.push({ signOut: o || null }); setTimeout(() => window.AUTHCB && AUTHCB("SIGNED_OUT"), 0); return {}; },
} });
window.fetch = async () => new Response(JSON.stringify({ error: "not signed in as the owner" }), { status: 401 });
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
    base = f"http://127.0.0.1:{srv.server_address[1]}"

    failures = []
    def check(ok, msg):
        print(("PASS " if ok else "FAIL ") + msg)
        if not ok: failures.append(msg)

    with sync_playwright() as p:
        exe = chrome()
        b = p.chromium.launch(**({"executable_path": exe} if exe else {}))

        def page(sb, path="/index.html"):
            pg = b.new_page(viewport={"width": 390, "height": 844})
            pg.errors = []; pg.on("pageerror", lambda e: pg.errors.append(str(e)))
            pg.add_init_script(f"window.SB = {sb};")
            pg.goto(base + path); pg.wait_for_timeout(800)
            return pg
        msg = lambda pg: pg.text_content("#signin-msg") or ""

        pg = page("{}", "/index.html?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired")
        check(pg.is_visible("#signin"), "an expired link shows the sign-in screen, not a blank page")
        check("expired or was already used" in msg(pg), f"it says the link expired or was used ({msg(pg)!r})")
        check("error" not in pg.url, f"the error is cleared from the address ({pg.url})")
        check(not pg.errors, f"no page errors {pg.errors[:1]}")
        pg.close()

        pg = page("{ rateLimited: true }")
        pg.fill("#email", "keith@example.com"); pg.click("#signin-form button"); pg.wait_for_timeout(300)
        check("2 an hour" in msg(pg), f"the rate limit is explained ({msg(pg)!r})")
        otp = pg.evaluate("AUTH.find((a) => a.otp)")
        check(otp and otp["otp"]["options"]["emailRedirectTo"] == base + "/", f"the link goes back to the app's root ({otp})")
        pg.close()

        pg = page("{ session: true, deadSession: true }")
        pg.wait_for_timeout(600)
        check(pg.is_visible("#signin"), "a dead session goes back to the sign-in screen")
        check("You were signed out" in msg(pg), f"it says you were signed out ({msg(pg)!r})")
        check("owner" not in msg(pg) and "owner" not in (pg.text_content("#status") or ""), "it doesn't claim the account isn't the owner")
        check(pg.evaluate("AUTH.some((a) => a.signOut && a.signOut.scope === 'local')"), "it signs out this device only")
        pg.close()

        pg = page("{ session: true }")
        check("isn't Hopper's owner" in (pg.text_content("#status") or ""), "a live session that isn't the owner still gets the owner message")
        pg.evaluate("document.getElementById('signout-btn').click()"); pg.wait_for_timeout(300)
        check(pg.evaluate("JSON.stringify(AUTH.filter((a) => 'signOut' in a).map((a) => a.signOut))") == '[{"scope":"local"}]',
              "Sign out signs out this device only")
        pg.close()

        pg = page("{}")
        check(pg.is_visible("#code-form"), "the code box is on the sign-in screen")
        pg.fill("#email", "keith@example.com"); pg.fill("#code", "999999"); pg.click("#code-form button"); pg.wait_for_timeout(300)
        check("expired or is wrong" in msg(pg), f"a wrong code says so ({msg(pg)!r})")
        pg.fill("#code", "123 456"); pg.click("#code-form button"); pg.wait_for_timeout(600)
        v = pg.evaluate("AUTH.filter((a) => a.verify).pop()")
        check(v and v["verify"] == {"email": "keith@example.com", "token": "123456", "type": "email"}, f"the code goes to verifyOtp as type email ({v})")
        check(pg.is_visible("#home"), "a right code opens the app")
        pg.close()

        pg = page("{ throwSession: true }")
        check(pg.is_visible("#signin"), "getSession throwing still shows the sign-in screen")
        pg.close()
        b.close()

    srv.shutdown(); shutil.rmtree(tmp)
    print("\nAll checks passed." if not failures else f"\n{len(failures)} check(s) failed.")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
