// Hopper service worker. Deployed from GitHub (iamkeithmason/hopper) via Vercel.
// Minimal service worker: makes Hopper installable and lets Android list it as a share target.
// No caching of the app itself: every request goes to the network.
// Shares arrive as POST /share (multipart, so images can come too). The worker parks any images in the
// "hopper-share" cache and redirects to GET /share with the text fields, where the page picks them up.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "POST" || u.pathname !== "/share") return;
  e.respondWith((async () => {
    const q = new URLSearchParams();
    try {
      const f = await e.request.formData();
      for (const k of ["title", "text", "url"]) { const v = f.get(k); if (typeof v === "string" && v) q.set(k, v); }
      const files = f.getAll("images").filter((x) => x && typeof x !== "string" && String(x.type).startsWith("image/"));
      const cache = await caches.open("hopper-share");
      for (const k of await cache.keys()) await cache.delete(k);
      let i = 0;
      for (const file of files.slice(0, 4)) {
        await cache.put(`/shared-image/${i++}`, new Response(file, { headers: { "content-type": file.type } }));
      }
      if (i) q.set("images", String(i));
    } catch (_) { /* fall through with whatever was read */ }
    return Response.redirect(`/share?${q}`, 303);
  })());
});
