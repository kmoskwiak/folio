import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type AppHandle } from "../src/app";

let dir!: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "brain-info-"));
  await writeFile(join(dir, "Welcome.md"), "# Welcome\n");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function serverInfo(handle: AppHandle) {
  const r = await handle.app.handle(new Request("http://localhost/api/server-info"));
  return { status: r.status, json: await r.json() };
}

describe("GET /api/server-info", () => {
  test("returns the configured vault title", async () => {
    const handle = createApp({ vaultDir: dir, gitAutocommit: false, vaultTitle: "Work" });
    const r = await serverInfo(handle);
    expect(r.status).toBe(200);
    expect(r.json.vaultTitle).toBe("Work");
    expect(r.json.viewOnly).toBe(false);
    expect(typeof r.json.version).toBe("string");
  });

  test("vaultTitle is null when not configured", async () => {
    const handle = createApp({ vaultDir: dir, gitAutocommit: false });
    const r = await serverInfo(handle);
    expect(r.status).toBe(200);
    expect(r.json.vaultTitle).toBeNull();
  });
});
