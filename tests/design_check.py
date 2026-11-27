"""Design guardrail: every rendered design value is a token or already in tests/design-baseline.json.

Renders the real app against a fake API (as the other checks do) in headless Chrome, at 390px (phone, touch) and
1440px, light and dark, with reduced motion on, through the feed, the phone's navigation sheet, a project with
topics, an open note and the capture sheet. It reads the computed style of every visible element and sorts the
values into families: type, icon, spacing, radius, colour, shadow and motion. A value passes when it equals a
design token (a custom property resolved on the page; a shadow when each of its layers is a token's layer) or
appears in the baseline. Source rules on style.css add what rendering can't see: every :hover sits inside @media (hover: hover), nothing scales from 0, and every
transition names its duration with a token.

The baseline holds the drift that existed when the check arrived (26 Nov 2026). It may only shrink:
  python3 tests/design_check.py               check; exit 0 clean, 1 new drift, 2 could not run
  python3 tests/design_check.py --baseline    drop baseline entries no page renders any more (never adds)
  python3 tests/design_check.py --self-test   prove the check fails on a page with planted drift
To admit a new value on purpose, add it to "admitted" in the baseline by hand with a "reason".
Run before pushing style changes.
"""
import datetime, functools, http.server, json, os, re, shutil, sys, tempfile, threading

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASELINE = os.path.join(ROOT, "tests", "design-baseline.json")
FAMILIES = ("type", "icon", "spacing", "radius", "colour", "shadow", "motion", "source")

try:
    from playwright.sync_api import sync_playwright
    sys.path.insert(0, os.path.join(ROOT, "tests"))
    from phone_nav_check import STUB, chrome
except Exception as e:  # a missing browser or library must never read as a pass
    print(f"design check could not run: {e}")
    sys.exit(2)

# A richer fake feed than the nav check's: a Keep colour, a quote, a locked note, a note with tags and a link.
STUB = STUB.replace(
    '[1, 2, 3, 4].map((i) => fakeCard(i))',
    '[1, 2, 3, 4, 5, 6].map((i) => fakeCard(i, i == 2 ? { color: "YELLOW" } : i == 3 ? { format: "quote", excerpt: "A quoted line" } : i == 5 ? { locked: true } : {}))'
).replace(
    'tags: [], images: [], links: []',
    'tags: [{ name: "Lore", kind: "topic" }, { name: "Alpha", kind: "project" }], why_saved: "Because", images: [], links: [{ url: "https://example.com/a", title: "Example" }]')

# Read in the page: every visible element's values per family, plus every custom property resolved as a token.
READ = r"""() => {
  const probe = document.createElement("div"); document.body.append(probe);
  const resolve = (prop, val) => { probe.style.cssText = ""; probe.style.setProperty(prop, val); return getComputedStyle(probe).getPropertyValue(prop); };
  const names = new Set();
  for (const sh of document.styleSheets) { let rules; try { rules = sh.cssRules; } catch { continue; }
    const walk = (rs) => { for (const r of rs) { if (r.style) for (const p of r.style) if (p.startsWith("--")) names.add(p); if (r.cssRules) walk(r.cssRules); } };
    walk(rules); }
  const tokens = { colour: new Set(), length: new Set(), time: new Set(), easing: new Set(), shadow: new Set() };
  const layers = (v) => v.split(/,(?![^(]*\))/).map((x) => x.trim());
  const scopes = [document.documentElement, ...document.querySelectorAll(".card, .pop, .menu, [class*='c-']")];
  for (const scope of scopes) { const cs = getComputedStyle(scope);
    for (const n of names) { const raw = cs.getPropertyValue(n).trim(); if (!raw) continue;
      const c = resolve("color", raw); if (c && raw !== "" && /^(#|rgb|hsl)/.test(raw)) tokens.colour.add(c);
      if (!/^--(fs|lh)-/.test(n) && /^-?[\d.]+(px|rem|em)$|^(clamp|calc|min|max)\(/.test(raw)) tokens.length.add(resolve("width", raw));
      if (/^[\d.]+m?s$/.test(raw)) tokens.time.add(resolve("transition-duration", raw));
      if (/^(cubic-bezier|ease|linear|steps)/.test(raw)) tokens.easing.add(resolve("transition-timing-function", raw));
      if (/\dpx/.test(raw) && /(rgb|#|hsl)/.test(raw)) { const sh = resolve("box-shadow", raw); if (sh && sh !== "none") layers(sh).forEach((l) => tokens.shadow.add(l)); } } }
  const pairs = new Set(), sizes = new Set(); const rcs = getComputedStyle(document.documentElement);
  for (const n of names) if (n.startsWith("--fs-")) { const lh = rcs.getPropertyValue("--lh-" + n.slice(5)).trim(); const fs = rcs.getPropertyValue(n).trim();
    if (fs && lh) { const f = resolve("width", fs), l = resolve("width", lh); pairs.add(`${f}/${l}`); sizes.add(f); } }
  tokens.typePairs = pairs; tokens.fontSizes = sizes;
  tokens.caps = parseFloat(rcs.getPropertyValue("--caps")) || null;
  probe.remove();
  const out = [];
  const px = (v) => v && v !== "0px" && v !== "auto" && v !== "normal";
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
    const cs = getComputedStyle(el); if (cs.visibility === "hidden" || cs.display === "none" || el.closest("[hidden]")) continue;
    const sel = el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).join(".") : "");
    const v = [];
    if ([...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) || /^(INPUT|TEXTAREA)$/.test(el.tagName))
      v.push(["type", `${cs.fontFamily.split(",")[0].replace(/"/g, "")} ${cs.fontWeight} ${cs.fontSize}/${cs.lineHeight} ${cs.letterSpacing} ${cs.textTransform} ${cs.fontStyle}`]);
    for (const p of ["marginTop", "marginRight", "marginBottom", "marginLeft", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "rowGap", "columnGap"])
      if (px(cs[p]) && !(cs.position === "fixed" && p.startsWith("padding"))
          && !(p.startsWith("margin") && String(el.computedStyleMap?.().get(p.replace(/[A-Z]/, (c) => "-" + c.toLowerCase()))) === "auto"))
        v.push(["spacing", cs[p]]);  // an auto margin resolves to whatever space is left, so it isn't a design value
    if (cs.borderTopLeftRadius !== "0px") v.push(["radius", cs.borderTopLeftRadius]);
    v.push(["colour", cs.color]);
    if (cs.backgroundColor !== "rgba(0, 0, 0, 0)") v.push(["colour", cs.backgroundColor]);
    if (cs.borderTopStyle !== "none" && cs.borderTopWidth !== "0px" && cs.borderTopColor !== "rgba(0, 0, 0, 0)") v.push(["colour", cs.borderTopColor]);
    if (cs.boxShadow !== "none") v.push(["shadow", cs.boxShadow]);
    if (el.tagName === "svg" && r.width < 64) { const pc = getComputedStyle(el.parentElement);
      v.push(["icon", `${Math.round(r.width)}x${Math.round(r.height)} in ${pc.fontSize}/${pc.lineHeight}`]); }
    if (cs.transitionDuration.split(",").some((d) => parseFloat(d) > 0))
      cs.transitionProperty.split(",").forEach((p, i) => { const d = cs.transitionDuration.split(",")[i] || cs.transitionDuration.split(",")[0];
        const e = cs.transitionTimingFunction.split(/,(?![^(]*\))/)[i] || cs.transitionTimingFunction;
        if (parseFloat(d) > 0) v.push(["motion", `${p.trim()} ${d.trim()} ${e.trim()}`]); });
    for (const [f, val] of v) out.push({ f, val, sel });
  }
  return { out, tokens: Object.fromEntries(Object.entries(tokens).map(([k, s]) => [k, s instanceof Set ? [...s] : s])) };
}"""


def is_token(f, val, tok):
    if f == "colour":
        return val in tok["colour"]
    if f in ("spacing", "radius"):
        return val.lstrip("-") in tok["length"]  # a negative margin pulls back by a step of the scale
    if f == "shadow":  # every layer is a layer of a shadow token (--shadow, --ring, --shadow-float, ...)
        return all(l.strip() in tok["shadow"] for l in re.split(r",(?![^(]*\))", val))
    if f == "motion":  # reduced motion is forced: only an opacity or colour change may still run
        prop, dur, ease = val.split(" ", 2)
        moves = prop in ("all", "transform", "translate", "scale", "rotate")
        return not moves and dur in tok["time"] and ease in tok["easing"]
    if f == "type":  # a named style: a size and line height pair from --fs-*/--lh-*, a standard weight, tracking only on caps
        *_, weight, pair, ls, transform, _style = val.split(" ")
        if pair not in tok["typePairs"] or weight not in ("400", "500", "600", "700"):
            return False
        if ls == "normal":
            return True
        size = float(pair.split("px")[0])
        return transform == "uppercase" and tok["caps"] is not None and abs(float(ls[:-2]) - tok["caps"] * size) < 0.05
    if f == "icon":  # sized from its text: as wide and tall as the font size of the element it sits in, on the scale
        m = re.match(r"(\d+)x(\d+) in ([\d.]+)px/", val)
        return bool(m) and m.group(1) == m.group(2) and f"{m.group(3)}px" in tok["fontSizes"] and abs(int(m.group(1)) - float(m.group(3))) < 0.6
    return False


def source_rules(css):
    """Rules on style.css text: hover only with a pointer, nothing from scale(0), durations as tokens."""
    found, stack, i = [], [], 0
    for m in re.finditer(r"([^{}]*)\{|\}", re.sub(r"/\*.*?\*/", "", css, flags=re.S)):
        if m.group(0) == "}":
            stack and stack.pop(); continue
        head = m.group(1).strip()
        stack.append(head)
        if ":hover" in head and not head.startswith("@") and not any("hover: hover" in s for s in stack if s.startswith("@media")):
            found.append(("source", f"unguarded hover: {head}", "style.css"))
    for m in re.finditer(r"scale\(\s*0\s*\)|scale:\s*0\s*;", css):
        found.append(("source", "scale from 0", "style.css"))
    for m in re.finditer(r"transition:\s*([^;}]+)", css):
        val = m.group(1).strip()
        if val != "none" and re.search(r"(?<![\w-])[\d.]+m?s\b", val):
            found.append(("source", f"raw duration: transition: {val}", "style.css"))
    return found


def render(app_dir, extra_css=""):
    tmp = tempfile.mkdtemp()
    shutil.copytree(app_dir, tmp, dirs_exist_ok=True)
    js = open(os.path.join(tmp, "app.js")).read()
    js, n = re.subn(r"^import \{ createClient \} from .*$", lambda _: STUB, js, count=1, flags=re.M)
    if n != 1:
        raise RuntimeError("couldn't find the Supabase import in app.js to replace")
    open(os.path.join(tmp, "app.js"), "w").write(js)
    if extra_css:
        open(os.path.join(tmp, "style.css"), "a").write(extra_css)

    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a): pass
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=tmp))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{srv.server_address[1]}/index.html"
    found = {}  # (family, value) -> first place seen
    with sync_playwright() as p:
        exe = chrome()
        b = p.chromium.launch(**({"executable_path": exe} if exe else {}))
        for scheme in ("light", "dark"):
            for W, H, phone in ((390, 844, True), (1440, 900, False)):
                ctx = b.new_context(viewport={"width": W, "height": H}, has_touch=phone, is_mobile=phone,
                                    color_scheme=scheme, reduced_motion="reduce")
                pg = ctx.new_page(); errors = []
                pg.on("pageerror", lambda e: errors.append(str(e)))
                pg.goto(url); pg.wait_for_timeout(800)
                if extra_css:
                    pg.evaluate("document.querySelector('.card .c-text')?.insertAdjacentHTML('beforeend', '<p class=\"planted\">x<svg class=\"planted-icon\"><use href=\"#i-pin\"/></svg></p>')")

                def read(state):
                    res = pg.evaluate(READ)
                    for x in res["out"]:
                        key = (x["f"], x["val"])
                        if is_token(x["f"], x["val"], res["tokens"]):
                            continue
                        found.setdefault(key, f"{scheme} {W}px {state}: {x['sel'][:70]}")
                read("feed")
                if phone:
                    pg.tap("#lb-open"); pg.wait_for_timeout(300); read("navigation sheet")
                    pg.tap("#ns-list .ns-row:has-text('Alpha')"); pg.wait_for_timeout(400); read("project with topics")
                pg.click(".card >> nth=0"); pg.wait_for_timeout(500); read("open note")
                pg.click("#d-back" if phone else "#detail-close"); pg.wait_for_timeout(300)
                pg.click("#lb-new" if phone else "#new-btn"); pg.wait_for_timeout(400); read("capture sheet")
                if errors:
                    raise RuntimeError(f"page errors at {scheme} {W}px: {errors}")
                ctx.close()
        b.close()
    srv.shutdown()
    css = open(os.path.join(tmp, "style.css")).read()
    for f, val, where in source_rules(css):
        found.setdefault((f, val), where)
    return found


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode == "--self-test":
        planted = """
.planted { color: #123456; margin: 13px; font: 600 19px/23px serif; border-radius: 5px; box-shadow: 0 2px 3px #123456; }
.planted-icon { width: 18px; height: 18px; }
.planted:hover { color: red; }
.planted { transition: transform 333ms linear; }
"""
        bad = render(os.path.join(ROOT, "app"), planted)
        base = load()
        new = {k for k in bad if k[1] not in base["families"].get(k[0], []) and not admitted(base, k)}
        want = {"colour": "rgb(18, 52, 86)", "spacing": "13px", "icon": "18x18", "source": "unguarded hover: .planted:hover", "type": "19px/23px", "radius": "5px", "shadow": "0px 2px 3px"}
        ok = True
        for f, needle in want.items():
            hit = any(k[0] == f and needle in k[1] for k in new)
            print(("PASS " if hit else "FAIL ") + f"planted {f} drift is caught ({needle})")
            ok &= hit
        sys.exit(0 if ok else 1)

    found = render(os.path.join(ROOT, "app"))
    if mode == "--baseline":
        today = datetime.date.today().isoformat()
        if not os.path.exists(BASELINE):
            fams = {f: sorted(v for (g, v) in found if g == f) for f in FAMILIES}
            save({"note": "Drift that existed when the design check arrived. May only shrink; see tests/design_check.py.",
                  "created": today, "updated": today, "families": fams, "admitted": []})
            print(f"baseline written: {sum(map(len, fams.values()))} values")
            sys.exit(0)
        base = load()
        dropped = 0
        for f in FAMILIES:
            keep = [v for v in base["families"].get(f, []) if (f, v) in found]
            dropped += len(base["families"].get(f, [])) - len(keep)
            base["families"][f] = keep
        base["updated"] = today
        save(base)
        new = [k for k in found if k[1] not in base["families"].get(k[0], []) and not admitted(base, k)]
        print(f"baseline: dropped {dropped} values no page renders any more; {len(new)} new values were NOT added")
        sys.exit(0)

    base = load()
    new = sorted(k for k in found if k[1] not in base["families"].get(k[0], []) and not admitted(base, k))
    stale = [(f, v) for f in FAMILIES for v in base["families"].get(f, []) if (f, v) not in found]
    stale += [(a["family"], a["value"]) for a in base.get("admitted", []) if (a["family"], a["value"]) not in found]
    for f, v in new:
        print(f"FAIL {f}: {v}   ({found[(f, v)]})")
    if stale:
        print(f"note: {len(stale)} baseline values no longer render; run with --baseline to drop them")
    total = sum(len(v) for v in base["families"].values())
    print(f"{'PASS' if not new else 'FAIL'} design check: {len(new)} new off-token values; baseline holds {total}")
    sys.exit(1 if new else 0)


def admitted(base, key):
    return any(a["family"] == key[0] and a["value"] == key[1] and a.get("reason") for a in base.get("admitted", []))


def load():
    if not os.path.exists(BASELINE):
        print("no baseline yet: run with --baseline once"); sys.exit(2)
    return json.load(open(BASELINE))


def save(base):
    with open(BASELINE, "w") as fh:
        json.dump(base, fh, indent=1, ensure_ascii=False); fh.write("\n")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        print(f"design check could not run: {e}")
        sys.exit(2)
