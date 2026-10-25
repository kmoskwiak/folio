import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { ASSETS } from "./assets";
import { VERSION } from "../version";

// Three-tier web client resolver:
//   1. **Embedded**     — ASSETS map populated by scripts/gen-web-assets.ts
//                         before `bun build --compile`. Files are bundled
//                         into the binary; Bun.file() reads them directly.
//   2. **Local disk**   — web/dist/ next to the cwd (dev workflow after
//                         `bun --cwd web run build`).
//   3. **GitHub cache** — last-resort download from a GitHub Release into
//                         `$XDG_CACHE_HOME/folio/web/<version>/`. Lets
//                         someone clone the repo, run `bun start` and have
//                         the UI work without building the frontend first.

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

function mimeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

// Where Tier 3 caches downloaded bundles.
function cacheDir(): string {
  const xdg = process.env.XDG_CACHE_HOME?.trim();
  const base = xdg && xdg !== "" ? xdg : join(homedir(), ".cache");
  return join(base, "folio", "web", VERSION);
}

interface Resolver {
  kind: "embedded" | "disk" | "cache" | "none";
  read(path: string): Promise<Uint8Array | null>;
  has(path: string): Promise<boolean>;
}

function embeddedResolver(): Resolver | null {
  if (Object.keys(ASSETS).length === 0) return null;
  return {
    kind: "embedded",
    async has(p) {
      return ASSETS[p] !== undefined;
    },
    async read(p) {
      const handle = ASSETS[p];
      if (!handle) return null;
      return new Uint8Array(await Bun.file(handle).arrayBuffer());
    },
  };
}

function diskResolver(dir: string): Resolver {
  return {
    kind: "disk",
    async has(p) {
      return existsSync(join(dir, p));
    },
    async read(p) {
      const abs = join(dir, p);
      if (!existsSync(abs)) return null;
      return readFile(abs);
    },
  };
}

async function downloadAndExtract(target: string): Promise<boolean> {
  await mkdir(target, { recursive: true });
  const url = `https://github.com/kmoskwiak/folio/releases/download/v${VERSION}/web-dist.tar.gz`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(
        `[web] download from ${url} failed: ${res.status} ${res.statusText}`,
      );
      return false;
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    const tarPath = join(target, "web-dist.tar.gz");
    await writeFile(tarPath, buf);
    // Use system tar (POSIX + Windows 10+).
    const proc = Bun.spawn(["tar", "-xzf", tarPath, "-C", target], {
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      console.warn(`[web] tar extract failed (exit ${code}): ${err}`);
      return false;
    }
    return existsSync(join(target, "index.html"));
  } catch (e) {
    console.warn("[web] download fallback failed:", e);
    return false;
  }
}

async function resolveWeb(): Promise<Resolver> {
  // Tier 1
  const embedded = embeddedResolver();
  if (embedded) {
    console.log(`[web] serving ${Object.keys(ASSETS).length} embedded assets`);
    return embedded;
  }
  // Tier 2
  const candidates = [
    process.env.FOLIO_WEB_DIR?.trim() || process.env.BRAIN_WEB_DIR?.trim() || "",
    join(process.cwd(), "web", "dist"),
    join(process.cwd(), "..", "web", "dist"),
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(join(c, "index.html"))) {
      console.log(`[web] serving from ${c}`);
      return diskResolver(c);
    }
  }
  // Tier 3
  const cache = cacheDir();
  if (existsSync(join(cache, "index.html"))) {
    console.log(`[web] serving from cache ${cache}`);
    return diskResolver(cache);
  }
  console.log(`[web] downloading bundle for v${VERSION} → ${cache}`);
  const ok = await downloadAndExtract(cache);
  if (ok) {
    console.log(`[web] cached at ${cache}`);
    return diskResolver(cache);
  }
  console.warn(
    `[web] no web client available. Run \`bun --cwd web run build\`, ` +
      `download the binary from GitHub Releases, or set FOLIO_WEB_DIR.`,
  );
  return { kind: "none", async has() { return false; }, async read() { return null; } };
}

let resolverPromise: Promise<Resolver> | undefined;
function getResolver(): Promise<Resolver> {
  if (!resolverPromise) resolverPromise = resolveWeb();
  return resolverPromise;
}

// Tests only: forget the cached resolver so the next mount re-resolves
// (e.g. after pointing FOLIO_WEB_DIR at a fixture).
export function resetWebResolverForTests(): void {
  resolverPromise = undefined;
}

// The web client uses only base-relative URLs, so serving it under a
// reverse-proxy prefix needs nothing more than a <base href> pointing there.
// Injected even without a prefix (<base href="/">): otherwise a SPA-fallback
// hit on a nested path like /foo/bar would resolve ./assets/… and api/…
// against /foo/. `basePath` is validated by normalizeBasePath (strict
// charset), so it is safe to interpolate.
export function injectBaseHref(html: string, basePath: string): string {
  return html.replace(/<head(\s[^>]*)?>/i, (m) => `${m}<base href="${basePath}/" />`);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// VAULT_TITLE in the initial <title>, so the window/taskbar shows it from
// the first frame instead of flashing "folio" until /api/server-info loads.
// The meta tag hands the same value to the SPA (App.tsx seeds its brand
// from it), so the top bar doesn't flash or shift either.
export const VAULT_TITLE_META = "folio-vault-title";

export function injectTitle(html: string, title: string | null): string {
  if (!title) return html;
  const t = escapeHtml(title);
  return html.replace(
    /<title>[^<]*<\/title>/i,
    () => `<title>${t}</title><meta name="${VAULT_TITLE_META}" content="${t}" />`,
  );
}

// VAULT_TITLE as the PWA's install name (dock, taskbar, launcher), so
// several installed vaults can be told apart. Left as-is if unparseable.
export function rewriteManifest(json: string, title: string | null): string {
  if (!title) return json;
  try {
    const m = JSON.parse(json) as Record<string, unknown>;
    return JSON.stringify({ ...m, name: title, short_name: title }, null, 2);
  } catch {
    return json;
  }
}

const MANIFEST = "manifest.webmanifest";

export interface MountWebOptions {
  // Public URL prefix ("/vault") or "" when served at the root.
  basePath?: string;
  // VAULT_TITLE; null/undefined keeps the built-in "folio" name.
  vaultTitle?: string | null;
}

// Mount as a low-priority catch-all. Must be called AFTER all /api/* and
// /mcp/* routes. Mutates `app` in place — `app` is typed as `unknown`
// because Elysia's deeply-parametrised type leaks into every chained
// route otherwise.
export async function mountEmbeddedWeb(
  app: unknown,
  opts: MountWebOptions = {},
): Promise<void> {
  const basePath = opts.basePath ?? "";
  const vaultTitle = opts.vaultTitle ?? null;
  // Warm the resolver so the first request doesn't pay the download cost.
  const r = await getResolver();
  if (r.kind === "none") return;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = app as any;
  a.get("/*", async ({ params, set }: { params: { "*"?: string }; set: { headers: Record<string, string>; status?: number } }) => {
    const raw = params["*"] ?? "";
    const cleaned = raw.replace(/^\/+/, "");
    const tryPaths = cleaned === "" ? ["index.html"] : [cleaned, "index.html"];
    for (const p of tryPaths) {
      const data = await r.read(p);
      if (data) {
        set.headers["content-type"] = mimeFor(p);
        // Only Vite's content-hashed output (assets/) is safe to cache
        // forever. Everything else keeps its name across releases (and
        // index.html / the manifest depend on VAULT_TITLE), so revalidate.
        set.headers["cache-control"] = p.startsWith("assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache";
        if (p === "index.html") {
          // Re-read and injected per request on purpose: with an on-disk
          // web/dist, a frontend rebuild renames the hashed assets, and a
          // cached index would keep pointing at the deleted ones.
          const html = injectTitle(
            injectBaseHref(new TextDecoder().decode(data), basePath),
            vaultTitle,
          );
          // Bytes, not a string: a string body would default the
          // content-type to text/plain.
          return new Response(new TextEncoder().encode(html));
        }
        if (p === MANIFEST) {
          const json = rewriteManifest(new TextDecoder().decode(data), vaultTitle);
          return new Response(new TextEncoder().encode(json));
        }
        return new Response(data as BodyInit);
      }
    }
    set.status = 404;
    return "Not Found";
  });
}
