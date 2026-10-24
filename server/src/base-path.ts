// --base-path support for requests that still carry the prefix.
//
// Every route is mounted at /. A reverse proxy that strips the prefix
// forwards /vault/api/tree as /api/tree and needs nothing else. But when
// folio is reached directly (localhost:3000/vault, in-cluster traffic, or a
// proxy that doesn't strip), requests arrive as /vault/…; the advertised
// URLs (<base href>, OAuth metadata) point there too. Stripping the prefix
// here makes both shapes work.

export function stripBasePath(req: Request, basePath: string): Request {
  if (basePath === "") return req;
  const url = new URL(req.url);
  const p = url.pathname;
  if (p !== basePath && !p.startsWith(`${basePath}/`)) return req;
  url.pathname = p.slice(basePath.length) || "/";
  return new Request(url, req);
}
