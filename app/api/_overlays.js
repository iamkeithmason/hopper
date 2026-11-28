// Consent and app banners out of the way before a page is shot or measured (backlog #71).
// Oak, White Rose and Airbnb all put a consent modal over the first screen, and the page reads spent their gap slots on it.
//
// clearOverlays(page) works in two steps, in the page and in its frames (consent tools often live in an iframe):
//   1. Choose the reject option: known consent-tool buttons first (OneTrust, Cookiebot, Didomi, Usercentrics, Quantcast,
//      CookieYes, Complianz, Osano, Iubenda, TrustArc, Sourcepoint, Funding Choices, HubSpot), then any button or link whose
//      label reads as reject, decline or necessary-only, inside something that talks about cookies or consent.
//      Never "accept": Hopper keeps the page as a reader who declined would see it.
//   2. Hide what is still in the way: fixed or sticky layers about cookies, consent, the app or a newsletter, open dialogs
//      about the same, and the dimmed backdrop behind them; the page's scroll lock is lifted.
// It returns what it did, so the capture can say so: { action: "rejected" | "hidden" | "none", clicked?, hidden? }.
// The underscore keeps Vercel from serving this file as a route of its own.

const KNOWN_REJECT = [
  "#onetrust-reject-all-handler", ".ot-pc-refuse-all-handler", "#CybotCookiebotDialogBodyButtonDecline",
  "#CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll", "#didomi-notice-disagree-button", ".didomi-continue-without-agreeing",
  "[data-testid='uc-deny-all-button']", "button[data-action='deny']", ".qc-cmp2-summary-buttons button[mode='secondary']",
  ".cky-btn-reject", ".cmplz-deny", ".osano-cm-denyAll", ".iubenda-cs-reject-btn", "#truste-consent-required",
  "button.sp_choice_type_13", "button.fc-cta-do-not-consent", "#hs-eu-decline-button", "[data-cookiefirst-action='reject']",
  ".cc-deny", "#cookiescript_reject", ".js-cookie-reject", "[data-cookie-reject]",
];

// Runs in the page (or a frame). Finds and clicks a reject option; returns its label, or null.
function rejectInPage(known) {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && parseFloat(s.opacity) > 0.05;
  };
  // Every root to look in: the document and any open shadow roots (Usercentrics draws its banner in one).
  const roots = [document];
  for (let i = 0; i < roots.length && roots.length < 60; i++) {
    for (const el of roots[i].querySelectorAll("*")) if (el.shadowRoot) roots.push(el.shadowRoot);
  }
  const label = (el) => (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ");
  for (const root of roots) {
    for (const sel of known) {
      const el = root.querySelector(sel);
      if (el && visible(el)) { el.click(); return label(el).slice(0, 60) || sel; }
    }
  }
  const REJECT = /^(reject|decline|refuse|deny|disagree)( all| everything| non-?essential| optional| additional| analytics)?( cookies| and close| tracking)?$|^(only|use only|allow only|accept only|use|allow|accept)( strictly)? (necessary|essential|required)( cookies| only)?$|^(strictly )?(necessary|essential|required) (cookies )?only$|^continue without (accepting|agreeing)$|^no,? thanks$|^reject cookies$|^only allow essential cookies$/i;
  const ABOUT = /cookie|consent|privacy|gdpr|tracking|personal data|your choices/i;
  for (const root of roots) {
    for (const el of root.querySelectorAll("button, a, [role='button'], input[type='button'], input[type='submit']")) {
      const t = label(el);
      if (!t || t.length > 48 || !REJECT.test(t) || !visible(el)) continue;
      // The button's own banner must be about consent: walk up a few levels for the words.
      let box = el, about = false;
      for (let i = 0; i < 8 && box; i++, box = box.parentElement || box.getRootNode()?.host) {
        if (ABOUT.test((box.innerText || "").slice(0, 3000)) || ABOUT.test(box.id || "") || ABOUT.test(String(box.className || ""))) { about = true; break; }
      }
      if (!about && !ABOUT.test(document.title + location.hostname)) continue;
      el.click();
      return t.slice(0, 60);
    }
  }
  return null;
}

// Runs in the page. Hides fixed or sticky layers about cookies, consent, the app or a newsletter, and dialogs about the
// same, then the dimmed backdrops behind them. Returns short labels of what it hid.
function hideInPage() {
  const ABOUT = /cookie|consent|gdpr|we use (cookies|tracking)|your privacy|privacy (settings|preferences|choices)|open in (the )?app|get the app|download (our|the) app|use the app|newsletter|subscribe to|sign up for (our|email)|join our mailing/i;
  const vw = innerWidth, vh = innerHeight;
  const hidden = [];
  const hide = (el, why) => {
    el.style.setProperty("display", "none", "important");
    el.setAttribute("data-hopper-hidden", why);
    hidden.push(why);
  };
  const tagOf = (el) => el.id ? `#${el.id}` : (typeof el.className === "string" && el.className.trim() ? `.${el.className.trim().split(/\s+/)[0]}` : el.tagName.toLowerCase());
  const layers = [];
  for (const el of document.querySelectorAll("body *")) {
    const s = getComputedStyle(el);
    const dialog = el.matches("dialog[open], [role='dialog'], [role='alertdialog'], [aria-modal='true']");
    if (!dialog && s.position !== "fixed" && s.position !== "sticky") continue;
    if (s.display === "none" || s.visibility === "hidden") continue;
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 20) continue;
    layers.push({ el, s, r, dialog });
  }
  let hidModal = false;
  for (const { el, r, dialog } of layers) {
    if (!el.isConnected || el.closest("[data-hopper-hidden]")) continue;
    const text = (el.innerText || "").slice(0, 2000);
    if (!ABOUT.test(text) && !ABOUT.test(el.id || "") && !ABOUT.test(String(el.className || ""))) continue;
    // A site header that only links to a privacy page is not a banner: it must be mostly about the banner's subject.
    if (el.matches("header, nav") || (el.querySelectorAll("a").length > 12 && text.length > 600)) continue;
    hide(el, `${dialog ? "dialog" : "layer"} ${tagOf(el)}`.slice(0, 60));
    if (r.width * r.height > vw * vh * 0.2 || dialog) hidModal = true;
  }
  // The dimmed backdrop a modal leaves: a near-empty fixed layer over most of the screen, partly transparent.
  if (hidModal || hidden.length) {
    for (const { el, s, r } of layers) {
      if (!el.isConnected || el.closest("[data-hopper-hidden]")) continue;
      if (s.position !== "fixed" || r.width < vw * 0.9 || r.height < vh * 0.9) continue;
      if ((el.innerText || "").trim().length > 40 || el.querySelector("img, video, canvas, picture")) continue;
      const bg = s.backgroundColor.match(/rgba?\(([^)]+)\)/)?.[1].split(",").map(Number);
      const alpha = bg ? (bg.length > 3 ? bg[3] : 1) : 0;
      if ((alpha > 0 && alpha < 0.95) || parseFloat(s.opacity) < 0.95 || s.backdropFilter !== "none") hide(el, `backdrop ${tagOf(el)}`.slice(0, 60));
    }
  }
  // Consent modals lock the page's scroll; a page that is now clear should scroll again.
  for (const el of [document.documentElement, document.body]) {
    if (!el) continue;
    const s = getComputedStyle(el);
    if (s.overflow === "hidden" || s.overflowY === "hidden") el.style.setProperty("overflow", "visible", "important");
    if (s.position === "fixed" && el === document.body) el.style.setProperty("position", "static", "important");
  }
  return hidden;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function clearOverlays(page) {
  const out = { action: "none" };
  try {
    // Consent tools often draw late; give them a moment.
    await wait(400);
    let clicked = null;
    for (const frame of [page.mainFrame(), ...page.frames().filter((f) => f !== page.mainFrame())]) {
      if (frame !== page.mainFrame() && !/consent|cmp|privacy|cookie|sourcepoint|trustarc|sp_message|didomi|usercentrics/i.test(frame.url() + (frame.name?.() ?? ""))) continue;
      clicked = await frame.evaluate(rejectInPage, KNOWN_REJECT).catch(() => null);
      if (clicked) break;
    }
    if (clicked) {
      out.action = "rejected";
      out.clicked = clicked;
      // Some tools reload the page or fade the banner out after the choice.
      await page.waitForNetworkIdle({ idleTime: 400, timeout: 3000 }).catch(() => {});
      await wait(500);
    }
    const hidden = await page.evaluate(hideInPage).catch(() => []);
    if (hidden.length) {
      out.hidden = hidden.slice(0, 8);
      if (out.action === "none") out.action = "hidden";
    }
  } catch (e) {
    out.error = String(e?.message ?? e).slice(0, 120);
  }
  return out;
}

// One plain sentence for a caption, or null when nothing was in the way.
export function overlayNote(o) {
  if (!o || o.action === "none") return null;
  const parts = [];
  if (o.clicked) parts.push(`chose "${o.clicked}" on the consent banner`);
  if (o.hidden?.length) parts.push(`hid ${o.hidden.length} overlay${o.hidden.length === 1 ? "" : "s"} (${o.hidden.slice(0, 3).join(", ")})`);
  return parts.join(", then ");
}
