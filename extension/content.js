// Hopper extension (HOP-8): a small Save button over images on hover, Pinterest-style.
// Shown on images at least 160px on screen. Can be switched off in Options.
// Lives in a shadow root so page styles can't reach it, and pages can't style it.

(async () => {
  if (location.hostname === "hopper-keith.vercel.app") return;
  const { hoverButton = true } = await chrome.storage.local.get("hoverButton");
  if (!hoverButton) return;

  const host = document.createElement("div");
  host.style.cssText = "position:fixed;top:0;left:0;z-index:2147483647;display:none;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>
    button { all: initial; font: 600 13px/1 system-ui, -apple-system, "Segoe UI", sans-serif; color: #f7f4ee;
      background: #1c1b19; border-radius: 16px; padding: 8px 12px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.3); }
    button:hover { background: #d6784a; }
    button[data-state="done"] { background: #3f7d4e; }
    button[data-state="error"] { background: #b3412e; }
  </style><button type="button">Save to Hopper</button>`;
  const btn = root.querySelector("button");
  document.documentElement.append(host);

  let target = null, hideTimer = null;

  function place() {
    if (!target) return;
    const r = target.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) { host.style.display = "none"; return; }
    host.style.transform = `translate(${Math.max(4, r.left + 8)}px, ${Math.max(4, r.top + 8)}px)`;
    host.style.display = "block";
  }

  function show(img) {
    clearTimeout(hideTimer);
    if (target !== img) { btn.textContent = "Save to Hopper"; btn.dataset.state = ""; btn.disabled = false; }
    target = img;
    place();
  }

  function hideSoon() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (btn.dataset.state !== "saving") { host.style.display = "none"; target = null; } }, 300);
  }

  document.addEventListener("mouseover", (e) => {
    const img = e.target instanceof HTMLImageElement ? e.target : null;
    if (!img) return;
    const r = img.getBoundingClientRect();
    if (r.width < 160 || r.height < 160 || !(img.currentSrc || img.src)) return;
    show(img);
  }, true);
  document.addEventListener("mouseout", (e) => { if (e.target === target) hideSoon(); }, true);
  host.addEventListener("mouseenter", () => clearTimeout(hideTimer));
  host.addEventListener("mouseleave", hideSoon);
  addEventListener("scroll", place, { passive: true, capture: true });

  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!target || btn.dataset.state === "saving") return;
    btn.dataset.state = "saving";
    btn.textContent = "Saving…";
    const r = await chrome.runtime.sendMessage({ type: "saveImage", src: target.currentSrc || target.src, pageUrl: location.href, title: document.title });
    btn.dataset.state = r?.ok ? "done" : "error";
    btn.textContent = r?.ok ? "Saved" : "Not saved";
    btn.title = r?.ok ? "" : (r?.error ?? "");
  });
})();
