// Hopper service worker. Deployed from GitHub (iamkeithmason/hopper) via Vercel.
// Minimal service worker: makes Hopper installable and lets Android list it as a share target.
// No caching yet: every request goes to the network.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
