import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { getExtensionsDir } from "../../src/pi-base/config.js";
import { getPiAgentDir } from "../../src/pi-base/paths.js";

describe("pi-base paths", () => {
  it("should return agent dir", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/tmp/pi");
    expect(getPiAgentDir()).toBe("/tmp/pi");
    vi.unstubAllEnvs();
  });

  it("should return extensions dir", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "/tmp/pi");
    expect(getExtensionsDir()).toBe(join("/tmp/pi", "extensions"));
    vi.unstubAllEnvs();
  });
});
