import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

// Consent page for Hopper's OAuth 2.1 server (Supabase Auth). MCP clients such as claude.ai send the owner
// here with ?authorization_id=…; the page shows who is asking, then approves or denies through the
// Supabase Auth consent endpoints. The session is shared with the main app (same storage), so a signed-in
// browser goes straight to the question. hopper-mcp separately refuses tokens for any other account.

const SUPABASE_URL = "https://hhfjfbuiuhhdhwhfwlpv.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable_GU1FVCM8tIsiGP8Zy_wZOQ_qac1hgnt"; // public by design

const sb = createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" },
});

const $ = (id) => document.getElementById(id);
const authId = new URLSearchParams(location.search).get("authorization_id");

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}

function say(...kids) { $("c-body").replaceChildren(...kids.filter(Boolean)); }

async function authCall(path, init = {}) {
  const { data: { session } } = await sb.auth.getSession();
  const r = await fetch(`${SUPABASE_URL}/auth/v1${path}`, {
    ...init,
    headers: { apikey: PUBLISHABLE_KEY, authorization: `Bearer ${session.access_token}`, "content-type": "application/json" },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.msg || j.message || j.error_description || `Error ${r.status}`);
  return j;
}

const SCOPE_WORDS = { openid: "confirm who you are", email: "see your email address", profile: "see your name", phone: "see your phone number" };

let started = false;
async function start() {
  if (started) return;
  if (!authId) { say(el("p", {}, "This page needs a request from an app such as Claude. Start the connection from there.")); return; }
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    say(el("p", { class: "muted" }, "An app wants to connect to your Hopper."));
    $("c-signin").hidden = false;
    return;
  }
  started = true;
  $("c-signin").hidden = true;
  try {
    const d = await authCall(`/oauth/authorizations/${encodeURIComponent(authId)}`);
    // Already approved for these scopes: Supabase hands back the redirect straight away.
    if (d.redirect_url) { location.assign(d.redirect_url); return; }
    const name = d.client?.name || "An app";
    $("c-title").textContent = `Connect ${name}`;
    const scopes = String(d.scope || "").split(" ").filter(Boolean).map((s) => SCOPE_WORDS[s] || s);
    say(
      el("p", {}, `${name} wants to read your Hopper notes and design references.`),
      el("ul", { class: "consent-list" },
        el("li", {}, "Search and read unlocked notes, links and saved images"),
        el("li", {}, "Read the design notes on your references"),
        scopes.length ? el("li", {}, `Also: ${scopes.join(", ")}`) : null,
      ),
      el("p", { class: "muted" }, "Locked notes are never shared. It can't change or delete anything."),
      el("p", { class: "muted" }, `Signed in as ${d.user?.email ?? session.user.email}.`),
      el("div", { class: "consent-actions" },
        el("button", { type: "button", class: "primary", onclick: () => decide("approve") }, "Allow"),
        el("button", { type: "button", class: "ghost", onclick: () => decide("deny") }, "Deny"),
      ),
    );
  } catch (e) {
    started = false;
    say(el("p", {}, "This request can't be completed: ", e.message), el("p", { class: "muted" }, "Requests expire after ten minutes. Start the connection again from the app."));
  }
}

async function decide(action) {
  for (const b of document.querySelectorAll(".consent-actions button")) b.disabled = true;
  $("c-msg").textContent = action === "approve" ? "Connecting…" : "Cancelling…";
  try {
    const r = await authCall(`/oauth/authorizations/${encodeURIComponent(authId)}/consent`, { method: "POST", body: JSON.stringify({ action }) });
    if (r.redirect_url) location.assign(r.redirect_url);
    else $("c-msg").textContent = "Done. You can close this tab.";
  } catch (e) {
    $("c-msg").textContent = e.message;
    for (const b of document.querySelectorAll(".consent-actions button")) b.disabled = false;
  }
}

$("c-signin").addEventListener("submit", async (e) => {
  e.preventDefault();
  // Come back to this same page (authorization_id included) after the sign-in link.
  const { error } = await sb.auth.signInWithOtp({ email: $("c-email").value.trim(), options: { emailRedirectTo: location.href } });
  $("c-msg").textContent = error ? error.message : "Check your email for a sign-in link. Open it in this browser.";
});

sb.auth.onAuthStateChange((event) => { if (event === "SIGNED_IN" || event === "INITIAL_SESSION") start(); });
