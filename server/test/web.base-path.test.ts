import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { discoverAuthorizationServerMetadata } from "@modelcontextprotocol/sdk/client/auth.js";
import { Elysia } from "elysia";
import { createApp, type AppHandle } from "../src/app";
import { stripBasePath } from "../src/base-path";
import { ASSETS } from "../src/web/assets";
import { injectBaseHref, mountEmbeddedWeb, resetWebResolverForTests } from "../src/web/serve";

const INDEX = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <script type="module" src="./assets/index.js"></script>
  </head>
  <body></body>
</html>`;

describe("injectBaseHref", () => {
  test("inserts <base href> right after <head>", () => {
    const out = injectBaseHref(INDEX, "/docs");
    expect(out).toContain('<head><base href="/docs/" />\n    <meta charset');
  });

  test("no base path → <base href=\"/\"> (keeps nested SPA-fallback paths working)", () => {
    expect(injectBaseHref(INDEX, "")).toContain('<head><base href="/" />');
  });

  test("handles <head> with attributes and only the first one", () => {
    const html = '<HEAD data-x="1"><title>t</title></HEAD><head>';
    expect(injectBaseHref(html, "/a/b")).toBe(
      '<HEAD data-x="1"><base href="/a/b/" /><title>t</title></HEAD><head>',
    );
  });
});

// Embedded assets (a release build) take precedence over FOLIO_WEB_DIR, so
// the fixture below would never be served.
describe.skipIf(Object.keys(ASSETS).length > 0)("mountEmbeddedWeb with a base path", () => {
  let webDir: string;
  let prevWebDir: string | undefined;
  let app: Elysia;

  beforeAll(async () => {
    // The resolver is cached per process; reset it so this fixture is used
    // regardless of test order, and again afterwards so nothing later sees
    // the deleted temp dir.
    resetWebResolverForTests();
    webDir = await mkdtemp(join(tmpdir(), "folio-web-"));
    await writeFile(join(webDir, "index.html"), INDEX);
    await writeFile(join(webDir, "folio.svg"), "<svg/>");
    prevWebDir = process.env.FOLIO_WEB_DIR;
    process.env.FOLIO_WEB_DIR = webDir;
    app = new Elysia();
    await mountEmbeddedWeb(app, { basePath: "/docs" });
  });

  afterAll(async () => {
    if (prevWebDir === undefined) delete process.env.FOLIO_WEB_DIR;
    else process.env.FOLIO_WEB_DIR = prevWebDir;
    resetWebResolverForTests();
    await rm(webDir, { recursive: true, force: true });
  });

  test.each(["/", "/index.html", "/some/spa/fallback"])("%s gets <base href>", async (p) => {
    const res = await app.handle(new Request(`http://localhost${p}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toContain('<base href="/docs/" />');
  });

  test("other files are served unchanged", async () => {
    const res = await app.handle(new Request("http://localhost/folio.svg"));
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(await res.text()).toBe("<svg/>");
  });

  test("no base path → nested fallback still gets <base href=\"/\">", async () => {
    const plain = new Elysia();
    await mountEmbeddedWeb(plain);
    const res = await plain.handle(new Request("http://localhost/foo/bar/"));
    expect(await res.text()).toBe(injectBaseHref(INDEX, ""));
  });
});

describe("OAuth / MCP URLs under a base path", () => {
  let h: AppHandle;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "folio-base-"));
    h = createApp({ vaultDir: dir, gitAutocommit: false, basePath: "/docs" });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function get(path: string) {
    return h.app.handle(new Request(`http://localhost${path}`));
  }

  test("protected-resource metadata advertises the prefixed resource", async () => {
    const body = (await (await get("/.well-known/oauth-protected-resource")).json()) as {
      resource: string;
      authorization_servers: string[];
    };
    expect(body.resource).toBe("http://localhost/docs/mcp");
    expect(body.authorization_servers).toEqual(["http://localhost/docs"]);
  });

  test("authorization-server metadata is also served as openid-configuration", async () => {
    const as = await (await get("/.well-known/oauth-authorization-server")).json();
    const oidc = await (await get("/.well-known/openid-configuration")).json();
    expect(oidc).toMatchObject(as as object);
    expect(oidc).toMatchObject({ jwks_uri: "http://localhost/docs/.well-known/jwks.json" });
    expect(await (await get("/.well-known/oauth-authorization-server/docs")).json()).toEqual(as);
    expect(await (await get("/.well-known/openid-configuration/docs")).json()).toEqual(oidc);
    expect(await (await get("/.well-known/jwks.json")).json()).toEqual({ keys: [] });
    expect(as).toMatchObject({
      issuer: "http://localhost/docs",
      authorization_endpoint: "http://localhost/docs/oauth/authorize",
      token_endpoint: "http://localhost/docs/oauth/token",
      registration_endpoint: "http://localhost/docs/oauth/register",
    });
  });

  test("401 on /mcp points resource_metadata under the prefix", async () => {
    await h.app.handle(
      new Request("http://localhost/api/auth/set", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newPassword: "secret" }),
      }),
    );
    const res = await h.app.handle(new Request("http://localhost/mcp", { method: "POST" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      'resource_metadata="http://localhost/docs/.well-known/oauth-protected-resource"',
    );
  });

  test("MCP SDK discovery succeeds through a prefix-stripping proxy", async () => {
    // Only /docs/* reaches folio; the host root answers 404, like a shared
    // ingress would.
    const fetchFn = async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (!url.pathname.startsWith("/docs/")) return new Response("nope", { status: 404 });
      url.pathname = url.pathname.slice("/docs".length);
      return h.app.handle(new Request(url, init));
    };
    const meta = await discoverAuthorizationServerMetadata("http://localhost/docs", { fetchFn });
    expect(meta?.token_endpoint).toBe("http://localhost/docs/oauth/token");
  });

  test("full OAuth flow: prefixed consent action, token valid for /mcp", async () => {
    await h.app.handle(
      new Request("http://localhost/api/auth/set", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newPassword: "secret" }),
      }),
    );
    const redirectUri = "http://localhost:9999/cb";
    const reg = await h.app.handle(
      new Request("http://localhost/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "t", redirect_uris: [redirectUri] }),
      }),
    );
    const { client_id } = (await reg.json()) as { client_id: string };
    const verifier = "v".repeat(64);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const resource = "http://localhost/docs/mcp";
    const params = {
      client_id,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      resource,
      scope: "vault:read",
      state: "s",
    };

    // Trailing slash too: the absolute action must not resolve to
    // /oauth/authorize/authorize.
    for (const path of ["/oauth/authorize", "/oauth/authorize/"]) {
      const q = new URLSearchParams({ ...params, response_type: "code", code_challenge_method: "S256" });
      const page = await get(`${path}?${q.toString()}`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('<form method="POST" action="/docs/oauth/authorize">');
    }

    const consent = await h.app.handle(
      new Request("http://localhost/oauth/authorize", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...params, decision: "allow", password: "secret" }),
      }),
    );
    expect(consent.status).toBe(302);
    const code = new URL(consent.headers.get("location")!).searchParams.get("code")!;
    const tok = await h.app.handle(
      new Request("http://localhost/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          client_id,
          redirect_uri: redirectUri,
          resource,
        }),
      }),
    );
    const { access_token } = (await tok.json()) as { access_token: string };
    expect(access_token).toBeTruthy();

    // The proxy strips /docs, so the request arrives at /mcp; the audience
    // check must still accept a token issued for .../docs/mcp.
    const mcp = await h.app.handle(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${access_token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
        }),
      }),
    );
    expect(mcp.status).not.toBe(401);
  });
});

describe("OAuth URLs without a base path", () => {
  test("advertised URLs are unchanged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "folio-nobase-"));
    try {
      const h = createApp({ vaultDir: dir, gitAutocommit: false });
      const res = await h.app.handle(
        new Request("http://localhost/.well-known/oauth-protected-resource"),
      );
      const body = (await res.json()) as { resource: string };
      expect(body.resource).toBe("http://localhost/mcp");
      // The OIDC alias exists only for prefixed deployments; at the root it
      // would just advertise OIDC support folio doesn't have.
      const oidc = await h.app.handle(
        new Request("http://localhost/.well-known/openid-configuration"),
      );
      expect(oidc.status).toBe(404);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("stripBasePath (direct access without a stripping proxy)", () => {
  test("strips the prefix at a segment boundary only", () => {
    const p = (u: string) => new URL(stripBasePath(new Request(u), "/docs").url).pathname;
    expect(p("http://localhost/docs")).toBe("/");
    expect(p("http://localhost/docs/")).toBe("/");
    expect(p("http://localhost/docs/api/tree")).toBe("/api/tree");
    expect(p("http://localhost/api/tree")).toBe("/api/tree");
    expect(p("http://localhost/docsearch")).toBe("/docsearch");
  });

  test("keeps method, headers, body and query", async () => {
    const r = stripBasePath(
      new Request("http://localhost/docs/api/x?q=1", {
        method: "POST",
        headers: { authorization: "Bearer t" },
        body: "hello",
      }),
      "/docs",
    );
    expect(r.url).toBe("http://localhost/api/x?q=1");
    expect(r.method).toBe("POST");
    expect(r.headers.get("authorization")).toBe("Bearer t");
    expect(await r.text()).toBe("hello");
  });

  test("no base path → same request object", () => {
    const req = new Request("http://localhost/docs/x");
    expect(stripBasePath(req, "")).toBe(req);
  });

  test("prefixed API and discovery requests reach the app", async () => {
    const dir = await mkdtemp(join(tmpdir(), "folio-strip-"));
    try {
      const h = createApp({ vaultDir: dir, gitAutocommit: false, basePath: "/docs" });
      const call = (path: string) =>
        h.app.handle(stripBasePath(new Request(`http://localhost${path}`), "/docs"));
      expect((await call("/docs/api/server-info")).status).toBe(200);
      const prm = (await (await call("/docs/.well-known/oauth-protected-resource")).json()) as {
        resource: string;
      };
      expect(prm.resource).toBe("http://localhost/docs/mcp");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
