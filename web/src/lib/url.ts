// folio can be served under a reverse-proxy prefix (`--base-path /vault`).
// The server then injects <base href="/vault/"> into index.html, so every
// server URL must resolve against document.baseURI instead of the origin
// root. Without a base path, baseURI is the page URL and these resolve to
// the same absolute paths as before.

// Directory part of the document base, e.g. "/" or "/vault/".
export function basePathname(): string {
  return new URL(".", document.baseURI).pathname;
}

// "/api/tree" → "http://host/vault/api/tree". Takes the root-style path so
// call sites keep reading like the server routes.
export function apiUrl(path: string): string {
  return new URL(path.replace(/^\/+/, ""), document.baseURI).toString();
}

// True for same-origin requests to the server's /api/* or /mcp(/*) routes,
// relative to the base path.
export function isApiUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url, document.baseURI);
  } catch {
    return false;
  }
  if (u.origin !== window.location.origin) return false;
  const base = basePathname();
  if (!u.pathname.startsWith(base)) return false;
  const rel = u.pathname.slice(base.length);
  return rel.startsWith("api/") || rel === "mcp" || rel.startsWith("mcp/");
}
