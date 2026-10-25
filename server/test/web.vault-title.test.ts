import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import { ASSETS } from "../src/web/assets";
import {
  injectTitle,
  mountEmbeddedWeb,
  resetWebResolverForTests,
  rewriteManifest,
  VAULT_TITLE_META,
} from "../src/web/serve";

const INDEX = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>folio</title>
  </head>
  <body></body>
</html>`;

const MANIFEST = JSON.stringify({
  name: "folio",
  short_name: "folio",
  start_url: "./",
  display: "standalone",
});

describe("injectTitle", () => {
  test("replaces the <title> text and adds the meta tag for the SPA", () => {
    const out = injectTitle(INDEX, "Work notes");
    expect(out).toContain("<title>Work notes</title>");
    expect(out).toContain(`<meta name="${VAULT_TITLE_META}" content="Work notes" />`);
  });

  test("escapes HTML in both", () => {
    const out = injectTitle(INDEX, `A & B <x> "q"`);
    const esc = "A &#38; B &#60;x&#62; &#34;q&#34;";
    expect(out).toContain(`<title>${esc}</title>`);
    expect(out).toContain(`content="${esc}"`);
  });

  test("no title → unchanged", () => {
    expect(injectTitle(INDEX, null)).toBe(INDEX);
  });

  test("replacement patterns in the title are literal", () => {
    expect(injectTitle(INDEX, "$& $1")).toContain("<title>$&#38; $1</title>");
  });
});

describe("rewriteManifest", () => {
  test("sets name and short_name, keeps the rest", () => {
    const m = JSON.parse(rewriteManifest(MANIFEST, "Work"));
    expect(m).toEqual({ name: "Work", short_name: "Work", start_url: "./", display: "standalone" });
  });

  test("no title → unchanged", () => {
    expect(rewriteManifest(MANIFEST, null)).toBe(MANIFEST);
  });

  test("invalid JSON → unchanged", () => {
    expect(rewriteManifest("{nope", "Work")).toBe("{nope");
  });
});

// Embedded assets (a release build) take precedence over FOLIO_WEB_DIR, so
// the fixture below would never be served.
describe.skipIf(Object.keys(ASSETS).length > 0)("mountEmbeddedWeb with a vault title", () => {
  let webDir: string;
  let prevWebDir: string | undefined;

  beforeAll(async () => {
    resetWebResolverForTests();
    webDir = await mkdtemp(join(tmpdir(), "folio-web-title-"));
    await writeFile(join(webDir, "index.html"), INDEX);
    await writeFile(join(webDir, "manifest.webmanifest"), MANIFEST);
    await writeFile(join(webDir, "folio.svg"), "<svg/>");
    await mkdir(join(webDir, "assets"));
    await writeFile(join(webDir, "assets", "index-abc123.js"), "1");
    prevWebDir = process.env.FOLIO_WEB_DIR;
    process.env.FOLIO_WEB_DIR = webDir;
  });

  afterAll(async () => {
    if (prevWebDir === undefined) delete process.env.FOLIO_WEB_DIR;
    else process.env.FOLIO_WEB_DIR = prevWebDir;
    resetWebResolverForTests();
    await rm(webDir, { recursive: true, force: true });
  });

  async function mount(vaultTitle?: string | null) {
    const app = new Elysia();
    await mountEmbeddedWeb(app, { vaultTitle });
    return (p: string) => app.handle(new Request(`http://localhost${p}`));
  }

  test("index.html carries the title", async () => {
    const get = await mount("Work");
    expect(await (await get("/")).text()).toContain("<title>Work</title>");
  });

  test("manifest carries the title and revalidates", async () => {
    const get = await mount("Work");
    const res = await get("/manifest.webmanifest");
    expect(res.headers.get("content-type")).toBe("application/manifest+json");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    const m = await res.json();
    expect(m.name).toBe("Work");
    expect(m.short_name).toBe("Work");
  });

  test("no title → folio everywhere, no meta tag, manifest still revalidates", async () => {
    const get = await mount();
    const html = await (await get("/")).text();
    expect(html).toContain("<title>folio</title>");
    expect(html).not.toContain(VAULT_TITLE_META);
    const res = await get("/manifest.webmanifest");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).toBe(MANIFEST);
  });

  test("only hashed assets/ are cached forever", async () => {
    const get = await mount();
    expect((await get("/assets/index-abc123.js")).headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    for (const p of ["/", "/folio.svg", "/manifest.webmanifest"]) {
      expect((await get(p)).headers.get("cache-control")).toBe("no-cache");
    }
  });
});
