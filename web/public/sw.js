// v2: drops entries an old root-scoped worker may have cached for a
// prefixed deployment (e.g. /vault/api/*).
const CACHE = "folio-shell-v2";
// Resolve against the registration scope ("/" or the --base-path prefix)
// instead of the origin root.
const SCOPE = new URL(self.registration.scope).pathname;
const SHELL = ["", "index.html", "manifest.webmanifest", "folio.svg"].map(
  (p) => SCOPE + p,
);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET") return;
  if (url.pathname.startsWith(SCOPE + "api/")) return; // bypass API
  if (url.pathname.startsWith(SCOPE + "mcp")) return; // bypass MCP (SSE)
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok && url.origin === self.location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached ?? new Response("offline", { status: 503 }));
      return cached ?? network;
    }),
  );
});
