#!/usr/bin/env python3
"""Search probe set (HOP-81): the queries from the 28 Nov 2026 stress test, rerun after each hopper-mcp change.

Runs every automated probe in tests/search_probes.json against the live MCP server, checks each result against its
expectation, saves a compact record (titles, scores, sizes, pass or fail) to tests/probe-results/ (gitignored), and compares it
with the newest earlier record so you can see which probes improved.

    HOPPER_MCP_TOKEN=... python3 tests/search_probes.py [--label after-hop72] [--only 6,17]
    python3 tests/search_probes.py --check <record.json>   # re-judge a saved record

The token is the static MCP bearer token from Supabase Vault (hopper_mcp_token). Never commit it.
Exit 0 when every automated probe without a depends_on passes, 1 otherwise, 2 when it could not run.
"""
import argparse, datetime, glob, json, os, re, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = os.path.join(HERE, "search_probes.json")
# Records hold note titles and summaries, so they stay out of the repo (gitignored); Keith's copies live in the
# claude.ai project files (hopper-trials/search-probes/). Point HOPPER_PROBE_RESULTS there to compare with them.
OUT = os.environ.get("HOPPER_PROBE_RESULTS", os.path.join(HERE, "probe-results"))
URL = os.environ.get("HOPPER_MCP_URL", "https://hhfjfbuiuhhdhwhfwlpv.supabase.co/functions/v1/hopper-mcp")


def call(tool, args, token):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": tool, "arguments": args}}).encode()
    req = urllib.request.Request(URL, data=body, headers={
        "content-type": "application/json", "accept": "application/json, text/event-stream",
        "authorization": f"Bearer {token}", "mcp-protocol-version": "2025-06-18"})
    with urllib.request.urlopen(req, timeout=120) as r:
        res = json.load(r)
    if "error" in res:
        raise RuntimeError(res["error"])
    return "".join(c.get("text", "") for c in res["result"]["content"] if c.get("type") == "text")


def record(text):
    """A compact, comparable record of one tool result."""
    try:
        data = json.loads(text)
    except ValueError:
        return {"chars": len(text), "count": 0, "message": text[:200], "items": []}
    items = data if isinstance(data, list) else [data]
    keep = []
    for x in items[:10]:
        if not isinstance(x, dict):
            continue
        keep.append({k: x[k] for k in ("id", "title", "display_title", "score", "pages", "link", "summary", "why_saved") if k in x})
        if "summary" in keep[-1]:
            keep[-1]["summary"] = keep[-1]["summary"][:160]
    return {"chars": len(text), "count": len(items) if isinstance(data, list) else 1, "items": keep, "text_head": text[:300]}


def label_text(x):
    return " ".join(str(x.get(k, "")) for k in ("title", "display_title", "summary", "why_saved"))


def judge(expect, rec):
    """(passed, reason) for one probe's record."""
    items, why = rec["items"], []
    n = expect.get("top_n")
    top = items[:n] if n else items
    if "min_results" in expect and rec["count"] < expect["min_results"]:
        why.append(f"{rec['count']} results, want at least {expect['min_results']}")
    if "max_chars" in expect and rec["chars"] > expect["max_chars"]:
        why.append(f"{rec['chars']:,} characters, want at most {expect['max_chars']:,}")
    if "min_with_pages" in expect:
        got = sum(1 for x in top if (x.get("pages") or 0) > 0)
        if got < expect["min_with_pages"]:
            why.append(f"{got} of top {len(top)} are captured pages, want {expect['min_with_pages']}")
    if "min_matching" in expect:
        got = sum(1 for x in top if re.search(expect["pattern"], label_text(x), re.I))
        if got < expect["min_matching"]:
            why.append(f"{got} of top {len(top)} match /{expect['pattern']}/, want {expect['min_matching']}")
    if "all_match" in expect:
        bad = [x.get("title") or x.get("display_title") for x in items if not re.search(expect["all_match"], label_text(x), re.I)]
        if bad:
            why.append(f"{len(bad)} off-topic: {'; '.join(map(str, bad[:4]))}")
    if "none_link" in expect:
        bad = [x.get("title") or x.get("display_title") for x in items if re.search(expect["none_link"], str(x.get("link", "")))]
        if bad:
            why.append(f"own UI returned: {'; '.join(map(str, bad))}")
    head = rec.get("text_head", "") + rec.get("message", "")
    if "contains" in expect and expect["contains"] not in head and not any(expect["contains"] in json.dumps(x) for x in items):
        why.append(f"missing '{expect['contains']}'")
    if "not_contains" in expect and expect["not_contains"] in head:
        why.append(f"says '{expect['not_contains']}'")
    return (not why, "; ".join(why) or "ok")


def previous(before):
    files = sorted(f for f in glob.glob(os.path.join(OUT, "*.json")) if os.path.abspath(f) != os.path.abspath(before or ""))
    return json.load(open(files[-1])) if files else None


def report(results, prev):
    old = {r["id"]: r for r in (prev or {}).get("results", [])}
    print(f"{'probe':<6}{'result':<8}{'was':<8}{'chars':>8}  reason")
    for r in results:
        o = old.get(r["id"])
        was = "-" if not o else ("pass" if o["passed"] else "fail")
        now = "pass" if r["passed"] else "fail"
        mark = " ↑" if o and r["passed"] and not o["passed"] else " ↓" if o and o["passed"] and not r["passed"] else ""
        dep = f" [needs {r['depends_on']}]" if r.get("depends_on") and not r["passed"] else ""
        print(f"{r['id']:<6}{now + mark:<8}{was:<8}{r['record']['chars']:>8}  {r['reason']}{dep}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", default="")
    ap.add_argument("--only", default="")
    ap.add_argument("--check", help="re-judge a saved record instead of calling the server")
    a = ap.parse_args()
    spec = json.load(open(SPEC))
    probes = {p["id"]: p for p in spec["probes"]}
    if a.check:
        saved = json.load(open(a.check))
        for r in saved["results"]:
            if r["id"] in probes and "expect" in probes[r["id"]]:
                r["passed"], r["reason"] = judge(probes[r["id"]]["expect"], r["record"])
        report(saved["results"], previous(a.check))
        return 0
    token = os.environ.get("HOPPER_MCP_TOKEN")
    if not token:
        print("Set HOPPER_MCP_TOKEN (Supabase Vault: hopper_mcp_token).", file=sys.stderr)
        return 2
    only = set(filter(None, a.only.split(",")))
    results = []
    for p in spec["probes"]:
        if "tool" not in p or (only and p["id"] not in only):
            continue
        try:
            rec = record(call(p["tool"], p["args"], token))
        except Exception as e:  # noqa: BLE001
            print(f"probe {p['id']} could not run: {e}", file=sys.stderr)
            return 2
        ok, why = judge(p["expect"], rec)
        results.append({"id": p["id"], "name": p["name"], "passed": ok, "reason": why, "depends_on": p.get("depends_on"), "record": rec})
    os.makedirs(OUT, exist_ok=True)
    name = datetime.date.today().isoformat() + (f"-{a.label}" if a.label else "") + ".json"
    path = os.path.join(OUT, name)
    report(results, previous(path))
    json.dump({"ran": datetime.datetime.now().isoformat(timespec="seconds"), "url": URL, "results": results}, open(path, "w"), indent=1, ensure_ascii=False)
    print(f"\nSaved {os.path.relpath(path)}. Manual probes: " + ", ".join(p["id"] for p in spec["probes"] if "manual" in p) + " (see search_probes.json).")
    return 0 if all(r["passed"] or r.get("depends_on") for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
