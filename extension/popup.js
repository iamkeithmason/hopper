// Popup: save the current page, with an optional "why" note, any selected text as a quote, and an optional screenshot.
const $ = (id) => document.getElementById(id);
let tab = null, selection = "";

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $("page").textContent = tab?.title || tab?.url || "";
  const { token } = await chrome.storage.local.get("token");
  if (!token) {
    $("status").replaceChildren(...["Add your capture token in ", Object.assign(document.createElement("a"), { href: "#", textContent: "Options", onclick: () => chrome.runtime.openOptionsPage() }), " first."].filter(Boolean));
    $("save").disabled = $("shot").disabled = true;
  }
  // Selected text on the page is saved as the note's text (a quote).
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => String(getSelection() || "").trim() });
    selection = (r?.result || "").slice(0, 20000);
  } catch (_) { /* pages like the Chrome Web Store don't allow scripts: no selection */ }
  if (selection) { $("sel").hidden = false; $("sel").textContent = `Quote: “${selection.slice(0, 160)}${selection.length > 160 ? "…" : ""}”`; }
  $("note").focus();
}

async function save(screenshot) {
  $("save").disabled = $("shot").disabled = true;
  $("status").textContent = screenshot ? "Taking the screenshot…" : /youtube\.com\/(watch|shorts|live)/.test(tab.url || "") ? "Reading the transcript and saving…" : "Saving…";
  const r = await chrome.runtime.sendMessage({
    type: "savePage", screenshot, windowId: tab.windowId, tabId: tab.id, url: tab.url, title: tab.title,
    text: selection, note: $("note").value.trim(), lock: $("lock").checked,
  });
  if (r?.ok) {
    $("status").textContent = "Saved to Hopper.";
    setTimeout(() => window.close(), 900);
  } else {
    $("status").textContent = `Not saved: ${r?.error ?? "unknown error"}`;
    $("save").disabled = $("shot").disabled = false;
  }
}

$("save").addEventListener("click", () => save(false));
$("shot").addEventListener("click", () => save(true));
$("note").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save(false); });
init();
