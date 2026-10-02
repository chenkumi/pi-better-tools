export const SCHEDULER_SCHEMA_VERSION = 1;

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ScheduleMode = "independent" | "session";
export type ScheduleState = "active" | "paused" | "cancelled" | "deleted";
export type RunStatus =
  | "planned"
  | "queued"
  | "running"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "skipped_busy"
  | "failed_preflight"
  | "orphaned";

export const terminalRunStatuses = new Set<RunStatus>([
  "succeeded",
  "failed",
  "cancelled",
  "skipped_busy",
  "failed_preflight",
  "orphaned",
]);

export interface ExecutionProfile {
  provider?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
}

export interface ScheduleTiming {
  kind: "cron" | "once";
  expression: string;
  timezone: string;
}

export interface ProcessIdentity {
  pid: number;
  startedAt: string;
  commandFingerprint: string;
}

export interface Schedule {
  id: string;
  revision: number;
  mode: ScheduleMode;
  state: ScheduleState;
  title?: string;
  prompt: string;
  cwd: string;
  timing: ScheduleTiming;
  execution?: ExecutionProfile;
  /** Explicit opt-in only; never stores credentials. */
  projectTrust?: boolean;
  targetSessionId?: string;
  lastPlannedAt?: string;
  lastRunId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunEvent {
  type: "cancel_requested" | "abort_requested" | "restore_skipped_user_change" | "diagnostic";
  at: string;
  detail?: string;
}

export interface Run {
  runId: string;
  scheduleId: string;
  mode: ScheduleMode;
  status: RunStatus;
  plannedAt: string;
  startedAt?: string;
  endedAt?: string;
  requestedProfile?: ExecutionProfile;
  /** Selected model and clamped thinking at the owned execution boundary. */
  effectiveProfile?: ExecutionProfile;
  /** Physical responder, which can differ from a virtual selected model. */
  actualModel?: { provider: string; model: string };
  targetSessionId?: string;
  restoreError?: string;
  childPiVersion?: string;
  processIdentity?: ProcessIdentity;
  error?: string;
  outputSummary?: string;
  events: RunEvent[];
}

export interface SchedulerRegistry {
  schemaVersion: typeof SCHEDULER_SCHEMA_VERSION;
  revision: number;
  schedules: Record<string, Schedule>;
}

export const emptyRegistry = (): SchedulerRegistry => ({
  schemaVersion: SCHEDULER_SCHEMA_VERSION,
  revision: 0,
  schedules: {},
});

const transitions: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  planned: ["queued", "cancelling", "cancelled", "skipped_busy", "failed_preflight", "orphaned"],
  queued: ["running", "cancelling", "cancelled", "failed", "failed_preflight", "skipped_busy", "orphaned"],
  running: ["cancelling", "succeeded", "failed", "cancelled", "orphaned"],
  cancelling: ["cancelled", "failed", "orphaned"],
  succeeded: [],
  failed: [],
  cancelled: [],
  skipped_busy: [],
  failed_preflight: [],
  orphaned: [],
};

export function isTerminalRunStatus(status: RunStatus): boolean {
  return terminalRunStatuses.has(status);
}

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return transitions[from].includes(to);
}

export function transitionRun(run: Run, to: RunStatus, at: string, details: Partial<Run> = {}): Run {
  if (!canTransitionRun(run.status, to)) {
    throw new Error(`Illegal run transition: ${run.status} -> ${to}`);
  }
  return {
    ...run,
    ...details,
    status: to,
    startedAt: to === "running" ? details.startedAt ?? at : run.startedAt,
    endedAt: isTerminalRunStatus(to) ? details.endedAt ?? at : run.endedAt,
  };
}

export function appendRunEvent(run: Run, event: RunEvent): Run {
  return { ...run, events: [...run.events, event] };
}
