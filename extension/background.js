// Hopper extension (HOP-8): background service worker.
// Every save goes to the hopper-clip function with the capture-only token from Options; hopper-clip passes it
// to hopper-api, which links, embeds, files and tags the note exactly as for captures from the app.
// Images (right-click, hover button, screenshots) are shrunk here to JPEG, at most 1600px on the long side.

const ENDPOINT = "https://hhfjfbuiuhhdhwhfwlpv.supabase.co/functions/v1/hopper-clip";
const MAX_SIDE = 1600;

async function token() {
  const { token } = await chrome.storage.local.get("token");
  if (!token) throw new Error("Add your capture token in the extension's Options first.");
  return token;
}

async function call(body) {
  // "endpoint" in storage is only for automated tests (a local stand-in for Hopper).
  const { endpoint } = await chrome.storage.local.get("endpoint");
  const r = await fetch(endpoint || ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${await token()}` },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Hopper said ${r.status}`);
  return j;
}

function b64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// Any image blob to { data (base64 JPEG), width, height }, shrunk to MAX_SIDE, on white for transparent images.
async function toJpeg(blob) {
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
  return { data: b64(await out.arrayBuffer()), width: w, height: h };
}

async function imageFromUrl(src) {
  const r = await fetch(src, { credentials: "include" });
  if (!r.ok) throw new Error(`Couldn't load the image (${r.status}).`);
  return toJpeg(await r.blob());
}

async function screenshot(windowId) {
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  return toJpeg(await (await fetch(dataUrl)).blob());
}

async function flash(tabId, ok, message) {
  if (tabId == null) return;
  await chrome.action.setBadgeBackgroundColor({ tabId, color: ok ? "#3f7d4e" : "#b3412e" });
  await chrome.action.setBadgeText({ tabId, text: ok ? "✓" : "!" });
  await chrome.action.setTitle({ tabId, title: ok ? "Saved to Hopper" : `Not saved: ${message}` });
  setTimeout(() => {
    chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
    chrome.action.setTitle({ tabId, title: "Save to Hopper (Alt+Shift+H)" }).catch(() => {});
  }, ok ? 2500 : 8000);
}

// Saves an image by its address. If the site won't hand the image over, saves the image's address as a link.
async function saveImage({ src, pageUrl, title, note }) {
  try {
    const img = await imageFromUrl(src);
    return await call({ action: "capture", title, url: pageUrl, note, images: [img] });
  } catch (e) {
    if (String(e.message).startsWith("Add your capture token")) throw e;
    return await call({ action: "capture", title, url: src, note: [note, `Image from ${pageUrl}`].filter(Boolean).join("\n") });
  }
}

const MENUS = [
  { id: "page", title: "Save page to Hopper", contexts: ["page"] },
  { id: "shot", title: "Save screenshot of this view", contexts: ["page", "image"] },
  { id: "image", title: "Save image to Hopper", contexts: ["image"] },
  { id: "selection", title: "Save quote to Hopper", contexts: ["selection"] },
  { id: "link", title: "Save link to Hopper", contexts: ["link"] },
];

chrome.runtime.onInstalled.addListener(async (details) => {
  await chrome.contextMenus.removeAll();
  for (const m of MENUS) chrome.contextMenus.create(m);
  if (details.reason === "install") chrome.runtime.openOptionsPage();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const title = tab?.title || undefined;
  const pageUrl = info.pageUrl || tab?.url;
  try {
    if (info.menuItemId === "page") await call({ action: "capture", title, url: pageUrl });
    else if (info.menuItemId === "shot") await call({ action: "capture", title, url: pageUrl, images: [await screenshot(tab.windowId)] });
    else if (info.menuItemId === "image") await saveImage({ src: info.srcUrl, pageUrl, title });
    else if (info.menuItemId === "selection") await call({ action: "capture", title, url: pageUrl, text: info.selectionText });
    else if (info.menuItemId === "link") await call({ action: "capture", url: info.linkUrl, note: `Found on ${title || pageUrl}` });
    await flash(tab?.id, true);
  } catch (e) {
    await flash(tab?.id, false, e.message);
  }
});

// Messages from the popup, the hover Save button and Options.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    if (msg.type === "ping") return call({ action: "ping" });
    if (msg.type === "savePage") {
      const images = msg.screenshot ? [await screenshot(msg.windowId)] : undefined;
      return call({ action: "capture", title: msg.title, url: msg.url, text: msg.text || undefined, note: msg.note || undefined, lock: !!msg.lock, images });
    }
    if (msg.type === "saveImage") {
      const r = await saveImage({ src: msg.src, pageUrl: msg.pageUrl, title: msg.title });
      await flash(sender.tab?.id, true);
      return r;
    }
    throw new Error("unknown message");
  })().then((r) => reply({ ok: true, result: r }), (e) => reply({ ok: false, error: e.message }));
  return true; // keeps the channel open for the async reply
});
