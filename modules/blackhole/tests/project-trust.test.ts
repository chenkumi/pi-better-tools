/** D01: one project-layer admission decision shared by runtime config, ConfigManager and UI sources. */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hostProjectTrust, isProjectLayerAdmitted, recordProjectTrust, setProjectTrustForTests } from "../src/core/project-trust.js";
import { ConfigManager } from "../src/pi-base/config-manager.js";
import { loadUnifiedConfig } from "../src/core/unified-config.js";

let root = "", agent = "", cwd = "";
const saved = { dir: process.env.PI_CODING_AGENT_DIR, passive: process.env.PI_BLACKHOLE_PASSIVE };

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "bh-trust-"));
  agent = join(root, "agent"); cwd = join(root, "work");
  mkdirSync(join(agent, "pi-blackhole"), { recursive: true }); mkdirSync(join(cwd, ".pi"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agent;
  delete process.env.PI_BLACKHOLE_PASSIVE;
  writeFileSync(join(agent, "pi-blackhole", "pi-blackhole-config.json"), JSON.stringify({ observeAfterTokens: 15000 }));
  writeFileSync(join(cwd, ".pi", "pi-blackhole-config.json"), JSON.stringify({ observeAfterTokens: 7777 }));
});
afterAll(() => {
  if (saved.dir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved.dir;
  if (saved.passive !== undefined) process.env.PI_BLACKHOLE_PASSIVE = saved.passive;
  rmSync(root, { recursive: true, force: true });
});
afterEach(() => setProjectTrustForTests(cwd, undefined));

describe("host trust answer", () => {
  it("only a literal true from isProjectTrusted() is trusted", () => {
    expect(hostProjectTrust({ isProjectTrusted: () => true })).toBe(true);
    expect(hostProjectTrust({ isProjectTrusted: () => false })).toBe(false);
    expect(hostProjectTrust({})).toBe(false);
    expect(hostProjectTrust(undefined)).toBe(false);
    expect(hostProjectTrust({ isProjectTrusted: () => "yes" })).toBe(false);
    expect(hostProjectTrust({ isProjectTrusted: () => { throw new Error("stale ctx"); } })).toBe(false);
  });
  it("unknown cwd is not admitted; a later untrusted answer revokes a previous trusted one", () => {
    expect(isProjectLayerAdmitted(cwd)).toBe(false);
    recordProjectTrust(cwd, { isProjectTrusted: () => true });
    expect(isProjectLayerAdmitted(cwd)).toBe(true);
    recordProjectTrust(cwd, { isProjectTrusted: () => false });
    expect(isProjectLayerAdmitted(cwd)).toBe(false);
  });
});

describe("project layer follows the decision", () => {
  const manager = () => new ConfigManager<{ observeAfterTokens: number }>({ filename: "pi-blackhole-config.json", defaults: { observeAfterTokens: 1 }, fields: () => [] } as any);

  it("runtime loader", () => {
    expect(loadUnifiedConfig(cwd).observeAfterTokens).toBe(15000); // unknown
    recordProjectTrust(cwd, { isProjectTrusted: () => true });
    expect(loadUnifiedConfig(cwd).observeAfterTokens).toBe(7777);
    recordProjectTrust(cwd, { isProjectTrusted: () => false });
    expect(loadUnifiedConfig(cwd).observeAfterTokens).toBe(15000);
  });

  it("ConfigManager layers and UI scope sources", () => {
    const m = manager(), dir = join(agent, "pi-blackhole");
    expect(m.layerValues("effective" as any, cwd, dir).observeAfterTokens).toBe(15000);
    expect(m.scopeSources(cwd, dir).some((s) => s.scope === "project")).toBe(false);
    recordProjectTrust(cwd, { isProjectTrusted: () => true });
    expect(m.layerValues("effective" as any, cwd, dir).observeAfterTokens).toBe(7777);
    expect(m.scopeSources(cwd, dir).some((s) => s.scope === "project")).toBe(true);
  });
});
