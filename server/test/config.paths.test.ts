import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import {
  getDefaultVaultDir,
  getDefaultSettingsDir,
} from "../src/config/paths";
import { loadConfig } from "../src/config";
import { CliError } from "../src/cli";

const originalEnv = { ...process.env };
let fakeHome: string;
let homedirSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  // Point the home dir at an empty temp dir so a real ~/.local/share/brain.md
  // on the machine running the tests can't trigger the legacy fallback.
  fakeHome = mkdtempSync(join(os.tmpdir(), "folio-paths-"));
  homedirSpy = spyOn(os, "homedir").mockReturnValue(fakeHome);
  delete process.env.XDG_DATA_HOME;
  delete process.env.XDG_CONFIG_HOME;
});

afterEach(() => {
  process.env = { ...originalEnv };
  homedirSpy.mockRestore();
  rmSync(fakeHome, { recursive: true, force: true });
});

describe("XDG defaults — V44", () => {
  test("getDefaultVaultDir falls back to $HOME/.local/share/folio/vault", () => {
    expect(getDefaultVaultDir()).toBe(
      join(fakeHome, ".local/share", "folio", "vault"),
    );
  });

  test("getDefaultSettingsDir falls back to $HOME/.config/folio", () => {
    expect(getDefaultSettingsDir()).toBe(join(fakeHome, ".config", "folio"));
  });

  test("XDG_DATA_HOME overrides vault default", () => {
    process.env.XDG_DATA_HOME = join(fakeHome, "xdgdata");
    expect(getDefaultVaultDir()).toBe(join(fakeHome, "xdgdata/folio/vault"));
  });

  test("XDG_CONFIG_HOME overrides settings default", () => {
    process.env.XDG_CONFIG_HOME = join(fakeHome, "xdgconfig");
    expect(getDefaultSettingsDir()).toBe(join(fakeHome, "xdgconfig/folio"));
  });

  test("empty XDG_DATA_HOME treated as unset", () => {
    process.env.XDG_DATA_HOME = "   ";
    expect(getDefaultVaultDir()).toBe(
      join(fakeHome, ".local/share", "folio", "vault"),
    );
  });
});

describe("legacy brain.md directories", () => {
  test("existing brain.md data dir is reused when folio dir is absent", () => {
    process.env.XDG_DATA_HOME = join(fakeHome, "data");
    mkdirSync(join(fakeHome, "data/brain.md/vault"), { recursive: true });
    expect(getDefaultVaultDir()).toBe(join(fakeHome, "data/brain.md/vault"));
  });

  test("existing brain.md config dir is reused when folio dir is absent", () => {
    process.env.XDG_CONFIG_HOME = join(fakeHome, "config");
    mkdirSync(join(fakeHome, "config/brain.md"), { recursive: true });
    expect(getDefaultSettingsDir()).toBe(join(fakeHome, "config/brain.md"));
  });

  test("folio dir wins when both exist", () => {
    process.env.XDG_DATA_HOME = join(fakeHome, "data");
    mkdirSync(join(fakeHome, "data/brain.md"), { recursive: true });
    mkdirSync(join(fakeHome, "data/folio"), { recursive: true });
    expect(getDefaultVaultDir()).toBe(join(fakeHome, "data/folio/vault"));
  });
});

describe("base path (FOLIO_BASE_PATH / --base-path)", () => {
  beforeEach(() => {
    delete process.env.FOLIO_BASE_PATH;
  });

  test("defaults to no prefix", () => {
    expect(loadConfig().basePath).toBe("");
  });

  test("env var sets the prefix", () => {
    process.env.FOLIO_BASE_PATH = "/docs";
    expect(loadConfig().basePath).toBe("/docs");
  });

  test("CLI flag beats env var", () => {
    process.env.FOLIO_BASE_PATH = "/env";
    expect(loadConfig({ basePath: "/cli" }).basePath).toBe("/cli");
  });

  test("env / means no prefix", () => {
    process.env.FOLIO_BASE_PATH = "/";
    expect(loadConfig().basePath).toBe("");
  });

  test("invalid env value throws CliError", () => {
    process.env.FOLIO_BASE_PATH = "docs/";
    expect(() => loadConfig()).toThrow(CliError);
  });
});

describe("vault title (VAULT_TITLE / --vault-title)", () => {
  beforeEach(() => {
    delete process.env.VAULT_TITLE;
  });

  test("defaults to null", () => {
    expect(loadConfig().vaultTitle).toBeNull();
  });

  test("env var sets it, trimmed", () => {
    process.env.VAULT_TITLE = "  Work  ";
    expect(loadConfig().vaultTitle).toBe("Work");
  });

  test("blank env var means unset", () => {
    process.env.VAULT_TITLE = "   ";
    expect(loadConfig().vaultTitle).toBeNull();
  });

  test("CLI flag beats env var", () => {
    process.env.VAULT_TITLE = "Env";
    expect(loadConfig({ vaultTitle: "Cli" }).vaultTitle).toBe("Cli");
  });

  test("blank CLI value falls back to env var", () => {
    process.env.VAULT_TITLE = "Env";
    expect(loadConfig({ vaultTitle: " " }).vaultTitle).toBe("Env");
  });
});
