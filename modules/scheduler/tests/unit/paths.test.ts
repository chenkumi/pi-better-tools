import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { describe, expect, it } from "vitest";

import { normalizeAgentDir, resolveAgentDir, resolveSchedulerPaths } from "../../src/paths.js";

describe("scheduler paths", () => {
  it("normalizes tilde and relative overrides before cwd can change", () => {
    expect(normalizeAgentDir("~/.pi/test-agent")).toBe(join(homedir(), ".pi", "test-agent"));
    expect(normalizeAgentDir("~\\.pi\\test-agent")).toBe(resolve(homedir(), ".pi\\test-agent"));
    expect(resolveSchedulerPaths("./isolated").agentDir).toBe(resolve("isolated"));
  });
  it("honors PI_AGENT_DIR for scheduler path resolution", () => {
    expect(resolveAgentDir({ PI_AGENT_DIR: "C:/Users/Ada/.pi/agent" })).toBe(resolve("C:/Users/Ada/.pi/agent"));
  });

  it("honors Pi's standard config override while retaining the legacy scheduler override", () => {
    expect(resolveAgentDir({ PI_CODING_AGENT_DIR: "C:/isolated" })).toBe(resolve("C:/isolated"));
    expect(resolveAgentDir({ PI_CODING_AGENT_DIR: "C:/pi", PI_AGENT_DIR: "C:/scheduler" })).toBe(resolve("C:/scheduler"));
  });

  it("places all persistent files below the scheduler root", () => {
    const paths = resolveSchedulerPaths("C:/Users/Ada/.pi/agent");
    expect(paths.rootDir).toBe(join(resolve("C:/Users/Ada/.pi/agent"), "pi-scheduler"));
    expect(paths.logsDir).toBe(join(paths.rootDir, "logs"));
  });
});
