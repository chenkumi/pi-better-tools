// Project-layer reads are gated by the host's trust answer; writes and the scope menu must follow the same decision,
// otherwise an untrusted project is offered "Project Local", the save reports success, and every later load ignores it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigManager } from "../src/pi-base/config-manager.ts";
import { setProjectTrustForTests } from "../src/core/project-trust.ts";

let globalDir: string;
let projectCwd: string;
const manager = () => new ConfigManager<{ memory: boolean }>({
  id: "scope-trust", filename: "scope-trust-config.json", label: "scope-trust", defaults: { memory: false },
  fields: (cfg) => [{ key: "memory", type: "boolean", label: "Memory", value: cfg.memory }] as never, configDir: globalDir,
});
const projectFile = () => join(projectCwd, ".pi", "scope-trust-config.json");

beforeEach(() => {
  globalDir = mkdtempSync(join(tmpdir(), "bh-scope-global-"));
  projectCwd = mkdtempSync(join(tmpdir(), "bh-scope-project-"));
});
afterEach(() => {
  setProjectTrustForTests(projectCwd, undefined);
  rmSync(globalDir, { recursive: true, force: true }); rmSync(projectCwd, { recursive: true, force: true });
});

describe("project scope follows the trust decision", () => {
  it("refuses to save or patch into an untrusted project instead of reporting a write that never takes effect", () => {
    setProjectTrustForTests(projectCwd, false);
    const mgr = manager();
    expect(() => mgr.save({ memory: true }, "project", projectCwd, globalDir)).toThrow(/not trusted/i);
    expect(() => mgr.patchScope({ memory: true }, "project", projectCwd, globalDir)).toThrow(/not trusted/i);
    expect(existsSync(projectFile())).toBe(false);
  });

  it("an unknown decision is not trusted either", () => {
    setProjectTrustForTests(projectCwd, undefined);
    expect(() => manager().save({ memory: true }, "project", projectCwd, globalDir)).toThrow(/not trusted/i);
  });

  it("a trusted project still saves and loads its own layer", () => {
    setProjectTrustForTests(projectCwd, true);
    const mgr = manager();
    expect(mgr.save({ memory: true }, "project", projectCwd, globalDir).created).toBe(true);
    expect(existsSync(projectFile())).toBe(true);
    expect(mgr.load(projectCwd, globalDir).memory).toBe(true);
  });

  it("global saves are unaffected by an untrusted project", () => {
    setProjectTrustForTests(projectCwd, false);
    expect(() => manager().save({ memory: true }, "global", projectCwd, globalDir)).not.toThrow();
  });

  it("the settings menu does not offer Project Local for an untrusted project", async () => {
    const offered = async (trusted: boolean) => {
      setProjectTrustForTests(projectCwd, trusted);
      let body: { render(width: number): string[] } | undefined;
      const tui = { terminal: { rows: 40, columns: 100 }, requestRender() {} } as never;
      const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t, inverse: (t: string) => t } as never;
      const ctx: any = { hasUI: true, cwd: projectCwd, modelRegistry: { getAvailable: () => [] }, ui: { notify: vi.fn(), custom: (factory: any) => new Promise<void>((resolve) => { body = factory(tui, theme, {}, () => resolve()); }) } };
      void manager().openSettings(ctx, projectCwd, vi.fn(), globalDir);
      await new Promise((resolve) => setTimeout(resolve, 20));
      // A selectable entry is a numbered one; an unavailable scope is shown without a number and marked disabled.
      return /\d\. Configure Project local settings/.test(body?.render(100).join("\n") ?? "");
    };
    expect(await offered(true)).toBe(true);
    expect(await offered(false)).toBe(false);
  });
});
