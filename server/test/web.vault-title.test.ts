import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import { ASSETS } from "../src/web/assets";
import {
  injectTitle,
  mountEmbeddedWeb,
  resetWebResolverForTests,
  rewriteManifest,
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
  test("replaces the <title> text", () => {
    expect(injectTitle(INDEX, "Work notes")).toContain("<title>Work notes</title>");
  });

  test("escapes HTML", () => {
    expect(injectTitle(INDEX, `A & B <x> "q"`)).toContain(
      "<title>A &#38; B &#60;x&#62; &#34;q&#34;</title>",
    );
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

  test("no title → folio everywhere, manifest still revalidates", async () => {
    const get = await mount();
    expect(await (await get("/")).text()).toContain("<title>folio</title>");
    const res = await get("/manifest.webmanifest");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).toBe(MANIFEST);
  });
});
