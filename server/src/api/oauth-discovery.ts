import { Elysia } from "elysia";

// V64: OAuth 2.1 discovery surface for MCP authorization spec 2025-11-25.
//
// Two well-known JSON documents let an MCP client discover where this
// server's authorization endpoints live without any pre-configuration:
//
//   GET /.well-known/oauth-protected-resource   (RFC 9728)
//     → resource URI + advertised authorization_servers + scopes_supported
//
//   GET /.well-known/oauth-authorization-server (RFC 8414)
//     → issuer + authorization_endpoint + token_endpoint + registration_endpoint
//       + code_challenge_methods_supported: ["S256"] (PKCE mandatory)
//
// We embed the AS in the same origin as the MCP server (same Elysia app)
// to keep the local-first single-binary deployment model intact. The
// `/oauth/{authorize,token,register}` endpoints themselves arrive in
// later commits — this file only advertises them.

const SUPPORTED_SCOPES = ["vault:read", "vault:write"] as const;

export function originOf(req: Request): string {
  // Honour proxy / tunnel headers so the advertised URLs match the
  // hostname the client actually used. Priority:
  //   1. Cloudflare `cf-visitor` JSON (`{"scheme":"https"}`) — set by
  //      Cloudflare Tunnel, which does NOT populate x-forwarded-proto.
  //      Without this, OAuth advertises http:// URLs even though the
  //      client connected over https → spec violation, client refuses.
  //   2. Standard x-forwarded-{proto,host}.
  //   3. Fallback to the request URL, but force HTTPS for any non-
  //      localhost host (assume reverse proxy with TLS termination).
  const host =
    req.headers.get("x-forwarded-host") ||
    req.headers.get("host") ||
    new URL(req.url).host;

  let proto: string | undefined;
  const cfVisitor = req.headers.get("cf-visitor");
  if (cfVisitor) {
    try {
      const v = JSON.parse(cfVisitor) as { scheme?: string };
      if (v.scheme === "http" || v.scheme === "https") proto = v.scheme;
    } catch {
      // ignore malformed
    }
  }
  if (!proto) proto = req.headers.get("x-forwarded-proto") ?? undefined;
  if (!proto) {
    const u = new URL(req.url);
    proto = u.protocol.replace(":", "");
  }
  // Spec defence: AS endpoints MUST be HTTPS. If the host looks public
  // (anything not localhost), upgrade. Direct local hits keep http.
  const isLocal =
    host.startsWith("localhost") ||
    host.startsWith("127.0.0.1") ||
    host.startsWith("[::1]");
  if (!isLocal && proto === "http") proto = "https";
  return `${proto}://${host}`;
}

// Public base URL a client used to reach us: origin plus the reverse-proxy
// prefix ("/vault" or ""). The auth middleware's audience check uses the same
// helper, so the resource we advertise and the one we validate can't drift.
export function publicBase(req: Request, basePath: string): string {
  return `${originOf(req)}${basePath}`;
}

// `basePath` is the public prefix a reverse proxy strips before forwarding.
// Routes stay at /, but every advertised URL includes it.
export function oauthDiscoveryRoutes(basePath = "") {
  const authServerMetadata = ({ request }: { request: Request }) => {
    const base = publicBase(request, basePath);
    return {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      scopes_supported: SUPPORTED_SCOPES,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
      service_documentation: "https://github.com/kmoskwiak/folio#-mcp-server",
    };
  };
  const protectedResourceMetadata = ({ request }: { request: Request }) => {
    const base = publicBase(request, basePath);
    return {
      resource: `${base}/mcp`,
      authorization_servers: [base],
      scopes_supported: SUPPORTED_SCOPES,
      bearer_methods_supported: ["header"],
      resource_documentation: "https://github.com/kmoskwiak/folio#-mcp-server",
    };
  };
  const app = new Elysia()
    .get("/.well-known/oauth-protected-resource", protectedResourceMetadata)
    .get("/.well-known/oauth-authorization-server", authServerMetadata);
  if (basePath === "") return app;

  // For an issuer with a path (https://host/vault), MCP clients try
  // /.well-known/oauth-authorization-server/vault and
  // /.well-known/openid-configuration/vault first — both at the host root,
  // outside the proxied prefix. The last fallback,
  // /vault/.well-known/openid-configuration, is the one that reaches us, so
  // only a prefixed deployment serves the OIDC document. OIDC parsers (e.g.
  // the MCP TypeScript SDK) require the OIDC-only fields; we never issue ID
  // tokens, hence the empty JWKS.
  const openidConfiguration = (ctx: { request: Request }) => {
    const meta = authServerMetadata(ctx);
    return {
      ...meta,
      jwks_uri: `${meta.issuer}/.well-known/jwks.json`,
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
    };
  };
  return app
    .get("/.well-known/openid-configuration", openidConfiguration)
    .get("/.well-known/jwks.json", () => ({ keys: [] }))
    // RFC 8414 / RFC 9728 / OIDC path-inserted locations. Only reachable
    // when the proxy also forwards these root-level /.well-known paths.
    .get(`/.well-known/oauth-authorization-server${basePath}`, authServerMetadata)
    .get(`/.well-known/openid-configuration${basePath}`, openidConfiguration)
    .get(`/.well-known/oauth-protected-resource${basePath}/mcp`, protectedResourceMetadata);
}
