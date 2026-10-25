// v2: drops entries an old root-scoped worker may have cached for a
// prefixed deployment (e.g. /vault/api/*).
// v3: drops shell entries (manifest, folio.svg) that older servers sent as
// `immutable`, so VAULT_TITLE reaches installs made before it existed.
const CACHE = "folio-shell-v3";
// Resolve against the registration scope ("/" or the --base-path prefix)
// instead of the origin root.
const SCOPE = new URL(self.registration.scope).pathname;
const SHELL = ["", "index.html", "manifest.webmanifest", "folio.svg"].map(
  (p) => SCOPE + p,
);

// Shell files aren't content-hashed, so their fetches skip the browser's
// HTTP cache, which may still hold a year-long `immutable` copy.
const isHashed = (url) => url.pathname.startsWith(SCOPE + "assets/");

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" }))))
      .catch(() => {}),
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
      // A navigate-mode Request can't take a RequestInit, so rebuild from
      // the URL. Cross-origin requests go out untouched (keeps no-cors).
      const fresh = url.origin === self.location.origin && !isHashed(url);
      const network = fetch(fresh ? new Request(req.url, { cache: "no-cache" }) : req)
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
