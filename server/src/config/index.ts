import { resolve } from "node:path";
import { getDefaultVaultDir } from "./paths";
import { normalizeBasePath, type CliOptions } from "../cli";

function boolEnv(name: string, def: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  return raw === "1" || raw.toLowerCase() === "true";
}

function resolveVaultDir(cli?: CliOptions): string {
  // V44 + V45: CLI > env > XDG default
  if (cli?.vaultDir && cli.vaultDir.trim() !== "") return resolve(cli.vaultDir);
  const env = process.env.VAULT_DIR;
  if (env && env.trim() !== "") return resolve(env);
  return getDefaultVaultDir();
}

function resolveVaultTitle(cli?: CliOptions): string | null {
  // CLI > env > none (folio). Blank counts as unset, like VAULT_DIR.
  const fromCli = cli?.vaultTitle?.trim();
  if (fromCli) return fromCli;
  const fromEnv = process.env.VAULT_TITLE?.trim();
  return fromEnv ? fromEnv : null;
}

function resolvePort(cli?: CliOptions): number {
  if (cli?.port !== undefined) return cli.port;
  return Number(process.env.PORT ?? 3000);
}

function resolveBasePath(cli?: CliOptions): string {
  // CLI > env > none. The CLI value is already normalised by parseArgs.
  if (cli?.basePath !== undefined) return normalizeBasePath(cli.basePath);
  return normalizeBasePath(process.env.FOLIO_BASE_PATH ?? "");
}

export interface AppConfig {
  vaultDir: string;
  // Display name shown in the top bar and window title instead of "folio".
  vaultTitle: string | null;
  port: number;
  // Public URL prefix ("/vault") or "" when served at the root.
  basePath: string;
  brainDir: string;
  mediaDir: string;
  trashDir: string;
  indexFile: string;
  gitAutocommit: boolean;
  gitDebounceMs: number;
}

export function loadConfig(cli?: CliOptions): AppConfig {
  return {
    vaultDir: resolveVaultDir(cli),
    vaultTitle: resolveVaultTitle(cli),
    port: resolvePort(cli),
    basePath: resolveBasePath(cli),
    brainDir: ".brain",
    mediaDir: ".media",
    trashDir: ".brain/trash",
    indexFile: ".brain/index.json",
    gitAutocommit: boolEnv("GIT_AUTOCOMMIT", true),
    gitDebounceMs: Number(process.env.GIT_AUTOCOMMIT_DEBOUNCE_MS ?? 15000),
  };
}

// Back-compat: module-level config used by app.ts when called without a CLI
// pre-parse. Reads env + XDG default but no CLI flags. basePath is pinned
// to "" here so an invalid FOLIO_BASE_PATH fails in index.ts with a usage
// error instead of throwing at import time.
export const config: AppConfig = loadConfig({ basePath: "" });

export type Config = AppConfig;
