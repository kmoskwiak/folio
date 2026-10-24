#!/usr/bin/env bun
// Build the current checkout into a single binary and install it locally.
//
// Mirrors the release workflow (web build → embed assets → bun --compile)
// but targets the host machine and writes straight into a bin dir.
// Nothing is uploaded anywhere.
//
// Run from repo root:
//     bun run install:local              # → ~/.local/bin/folio
//     bun run install:local folio-dev    # → ~/.local/bin/folio-dev
//
// Env:
//     FOLIO_INSTALL   target directory (default: $HOME/.local/bin)
//
// server/src/web/assets.ts is regenerated during the build and restored
// to its previous contents afterwards, even if the build fails.

import { $ } from "bun";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const ASSETS = join(REPO_ROOT, "server", "src", "web", "assets.ts");
const INSTALL_DIR = process.env.FOLIO_INSTALL ?? join(homedir(), ".local", "bin");
const NAME = process.argv[2] ?? "folio";
const OUT = join(INSTALL_DIR, process.platform === "win32" ? `${NAME}.exe` : NAME);

$.cwd(REPO_ROOT);

const originalAssets = readFileSync(ASSETS);
try {
  console.log("[install-local] building web client");
  await $`bun run build`.cwd(join(REPO_ROOT, "web"));

  console.log("[install-local] embedding web bundle");
  await $`bun scripts/gen-web-assets.ts`;

  console.log(`[install-local] compiling → ${OUT}`);
  mkdirSync(INSTALL_DIR, { recursive: true });
  await $`bun build --compile --minify --sourcemap=none --outfile=${OUT} server/src/index.ts`;
} finally {
  writeFileSync(ASSETS, originalAssets);
}

const version = await $`${OUT} --version`.nothrow().quiet().text();
console.log(`[install-local] installed ${OUT}${version.trim() ? ` (${version.trim()})` : ""}`);
if (!(process.env.PATH ?? "").split(":").includes(INSTALL_DIR)) {
  console.log(`[install-local] note: ${INSTALL_DIR} is not on your PATH`);
}
