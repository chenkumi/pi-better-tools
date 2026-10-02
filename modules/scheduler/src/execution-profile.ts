import type { ExecutionProfile, ThinkingLevel } from "./domain.js";

export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ThinkingLevel[];

export class ExecutionProfileValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionProfileValidationError";
  }
}

export function validateExecutionProfile(profile: ExecutionProfile | undefined): ExecutionProfile | undefined {
  if (!profile) return undefined;
  const normalized: ExecutionProfile = {
    ...(profile.provider ? { provider: profile.provider.trim() } : {}),
    ...(profile.model ? { model: profile.model.trim() } : {}),
    ...(profile.thinkingLevel ? { thinkingLevel: profile.thinkingLevel } : {}),
  };

  if (Boolean(normalized.provider) !== Boolean(normalized.model)) {
    throw new ExecutionProfileValidationError("provider and model must be supplied together");
  }
  if (normalized.provider === "" || normalized.model === "") {
    throw new ExecutionProfileValidationError("provider and model cannot be blank");
  }
  if (normalized.thinkingLevel && !thinkingLevels.includes(normalized.thinkingLevel)) {
    throw new ExecutionProfileValidationError(`Unsupported thinking level: ${normalized.thinkingLevel}`);
  }
  return Object.keys(normalized).length === 0 ? undefined : normalized;
}

export interface SessionProfileOutcome {
  requested?: ExecutionProfile;
  applied?: ExecutionProfile;
  restore?: "restored" | "skipped_user_change" | "not_needed";
}
