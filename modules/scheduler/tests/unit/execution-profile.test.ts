import { describe, expect, it } from "vitest";

import { ExecutionProfileValidationError, validateExecutionProfile } from "../../src/execution-profile.js";

describe("execution profile validation", () => {
  it("accepts inherited, complete, and thinking-only profiles", () => {
    expect(validateExecutionProfile(undefined)).toBeUndefined();
    expect(validateExecutionProfile({ provider: "openai", model: "gpt-test" })).toEqual({ provider: "openai", model: "gpt-test" });
    expect(validateExecutionProfile({ thinkingLevel: "high" })).toEqual({ thinkingLevel: "high" });
  });

  it("rejects an unpaired or blank explicit model override", () => {
    expect(() => validateExecutionProfile({ provider: "openai" })).toThrow(ExecutionProfileValidationError);
    expect(() => validateExecutionProfile({ model: "gpt-test" })).toThrow(ExecutionProfileValidationError);
    expect(() => validateExecutionProfile({ provider: " ", model: "gpt-test" })).toThrow(ExecutionProfileValidationError);
  });
});
