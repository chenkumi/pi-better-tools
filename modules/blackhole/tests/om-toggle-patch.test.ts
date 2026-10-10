/** D21: /blackhole om-off|om-on patch only `memory` in the global file and never claim an unapplied fallback. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const { testRoot } = vi.hoisted(() => {
  const { join } = require("node:path"), { tmpdir } = require("node:os");
  return { testRoot: join(tmpdir(), `pi-blackhole-omtoggle-${process.pid}-${Date.now()}`) };
});
vi.mock("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => join(testRoot, "agent") }));

import { registerPiVccCommand } from "../src/commands/pi-vcc.js";
import { setProjectTrustForTests } from "../src/core/project-trust.js";

const globalFile = () => join(testRoot, "agent", "pi-blackhole", "pi-blackhole-config.json");

function env() {
  let handler: any;
  const pi = { registerCommand: (_: string, def: any) => { handler = def.handler; } };
  const runtime: any = { ensureConfig: vi.fn(), config: { memory: true } };
  registerPiVccCommand(pi as any, runtime);
  const notes: Array<{ msg: string; level: string }> = [];
  const ctx: any = { cwd: join(testRoot, "work"), mode: "json", isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "s", getBranch: () => [] },
    ui: { notify: (msg: string, level: string) => notes.push({ msg, level }) } };
  return { run: (a: string) => handler(a, ctx), runtime, notes };
}

beforeEach(() => { rmSync(testRoot, { recursive: true, force: true }); mkdirSync(join(testRoot, "agent", "pi-blackhole"), { recursive: true }); mkdirSync(join(testRoot, "work", ".pi"), { recursive: true }); });
afterEach(() => { rmSync(testRoot, { recursive: true, force: true }); setProjectTrustForTests(join(testRoot, "work"), undefined); });

describe("om toggles", () => {
  it("om-off writes only memory=false; defaults and project layer stay out of the global file", async () => {
    writeFileSync(globalFile(), JSON.stringify({ compaction: "auto", memory: true, observeAfterTokens: 20000 }));
    writeFileSync(join(testRoot, "work", ".pi", "pi-blackhole-config.json"), JSON.stringify({ observeAfterTokens: 30000 }));
    const { run, runtime } = env();
    await run("om-off");
    expect(JSON.parse(readFileSync(globalFile(), "utf8"))).toEqual({ compaction: "auto", memory: false, observeAfterTokens: 20000 });
    expect(runtime.config.memory).toBe(false);
  });

  it("om-on into a missing/empty global file writes just memory", async () => {
    writeFileSync(globalFile(), "{}");
    const { run } = env();
    await run("om-on");
    expect(JSON.parse(readFileSync(globalFile(), "utf8"))).toEqual({ memory: true });
  });

  it("save failure: really applies the session fallback and says it was not persisted", async () => {
    // A directory where the file should be makes the write fail without touching real settings.
    rmSync(globalFile(), { force: true }); mkdirSync(globalFile(), { recursive: true });
    const { run, runtime, notes } = env();
    await run("om-off");
    expect(runtime.config.memory).toBe(false);
    expect(notes.at(-1)!.level).toBe("warning");
    expect(notes.at(-1)!.msg).toMatch(/not persisted/);
    expect(notes.some((n) => /Observational memory disabled/.test(n.msg))).toBe(false);
  });
});
