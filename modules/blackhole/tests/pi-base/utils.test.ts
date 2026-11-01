import { describe, expect, it, vi } from "vitest";
import { readBooleanEnv, readPositiveIntEnv } from "../../src/pi-base/config.js";

describe("pi-base config env readers", () => {
  it("should read boolean env", () => {
    vi.stubEnv("TEST_BOOL_TRUE", "true");
    vi.stubEnv("TEST_BOOL_FALSE", "0");
    expect(readBooleanEnv("TEST_BOOL_TRUE", false)).toBe(true);
    expect(readBooleanEnv("TEST_BOOL_FALSE", true)).toBe(false);
    expect(readBooleanEnv("TEST_NON_EXISTENT", true)).toBe(true);
    vi.unstubAllEnvs();
  });

  it("should read positive int env", () => {
    vi.stubEnv("TEST_INT", "100");
    vi.stubEnv("TEST_INVALID_INT", "abc");
    expect(readPositiveIntEnv("TEST_INT", 10)).toBe(100);
    expect(readPositiveIntEnv("TEST_INVALID_INT", 10)).toBe(10);
    vi.unstubAllEnvs();
  });
});
