import { ulid } from "ulid";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const STATE_TYPE = "pi-better-goal-state";
export const CONTROL_TYPE = "pi-better-goal-control";
export const MAX_AUTO_REQUESTS = 20;
export const MAX_EMPTY_RESPONSES = 3;
export const MAX_SNAPSHOT_BYTES = 64 * 1024;
const object = { additionalProperties: false } as const;
const text = (maxLength: number) => Type.String({ minLength: 1, maxLength, pattern: "\\S" });
const identity = { goalId: text(128), runId: text(128) };
export const VerificationSchema = Type.Array(Type.Object({ criterion: text(2000), evidence: text(4000) }, object), { minItems: 1, maxItems: 32 });
export const GoalSchema = Type.Object({
  version: Type.Literal(1), id: text(128), runId: text(128), objective: text(4000), cwd: text(4000),
  status: Type.Union([Type.Literal("active"), Type.Literal("paused"), Type.Literal("blocked"), Type.Literal("complete")]),
  autoRequests: Type.Integer({ minimum: 0, maximum: MAX_AUTO_REQUESTS }),
  emptyResponses: Type.Integer({ minimum: 0, maximum: MAX_EMPTY_RESPONSES }),
  stopReason: Type.Optional(text(4000)), suggestedAction: Type.Optional(text(2000)),
  resultSummary: Type.Optional(text(4000)), verification: Type.Optional(VerificationSchema),
  createdAt: text(64), updatedAt: text(64),
}, object);
export const SnapshotSchema = Type.Object({ version: Type.Literal(1), goal: Type.Union([GoalSchema, Type.Null()]) }, object);
export const GoalArgumentsSchema = Type.Union([
  Type.Object({ action: Type.Literal("get") }, object),
  Type.Object({ action: Type.Literal("complete"), ...identity, summary: text(4000), verification: VerificationSchema }, object),
  Type.Object({ action: Type.Literal("blocked"), ...identity, reason: text(4000), suggestedAction: text(2000) }, object),
]);
export type GoalState = Static<typeof GoalSchema>;
export type GoalSnapshot = Static<typeof SnapshotSchema>;
export type GoalArguments = Static<typeof GoalArgumentsSchema>;

export function validateSnapshot(value: unknown): GoalSnapshot {
  if (!Value.Check(SnapshotSchema, value)) throw new Error("GOAL_INVALID_STATE: Invalid or unknown-version latest goal snapshot; use /goal clear to discard it.");
  const goal = value.goal;
  if (goal && (!Number.isFinite(Date.parse(goal.createdAt)) || !Number.isFinite(Date.parse(goal.updatedAt)) ||
    (goal.status === "complete" && (!goal.resultSummary || !goal.verification)) ||
    (goal.status === "blocked" && (!goal.stopReason || !goal.suggestedAction)))) {
    throw new Error("GOAL_INVALID_STATE: Missing outcome or invalid timestamps in latest snapshot.");
  }
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, "utf8") > MAX_SNAPSHOT_BYTES || hasMalformedUnicode(value)) {
    throw new Error("GOAL_INVALID_STATE: Snapshot exceeds 64 KiB or contains malformed Unicode.");
  }
  return structuredClone(value);
}
// JSON.stringify escapes lone surrogates, so check the actual strings, not JSON syntax.
function hasMalformedUnicode(value: unknown): boolean {
  if (typeof value === "string") return /[\uD800-\uDFFF]/u.test(value);
  if (value && typeof value === "object") return Object.values(value).some(hasMalformedUnicode);
  return false;
}
export function validateArguments(value: unknown): asserts value is GoalArguments {
  if (!Value.Check(GoalArgumentsSchema, value) || hasMalformedUnicode(value)) throw new Error("GOAL_INVALID_ARGUMENTS: Expected get, complete with nonempty acceptance evidence, or blocked with a concrete action.");
}
export function newGoal(objective: string, cwd: string, now = new Date().toISOString()): GoalState {
  return validateSnapshot({ version: 1, goal: { version: 1, id: ulid().toLowerCase(), runId: ulid().toLowerCase(), objective, cwd,
    status: "active", autoRequests: 0, emptyResponses: 0, createdAt: now, updatedAt: now } }).goal!;
}
export function resumeGoal(goal: GoalState): GoalState {
  if (goal.status !== "paused" && goal.status !== "blocked") throw new Error("GOAL_INVALID_TRANSITION: Only paused or blocked goals can resume.");
  const { stopReason: _reason, suggestedAction: _action, resultSummary: _summary, verification: _verification, ...rest } = goal;
  return { ...rest, runId: ulid().toLowerCase(), status: "active", autoRequests: 0, emptyResponses: 0, updatedAt: new Date().toISOString() };
}
export function latestSnapshot(entries: readonly { type: string; customType?: string; data?: unknown }[]): GoalState | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "custom" && entry.customType === STATE_TYPE) return validateSnapshot(entry.data).goal;
  }
  return null;
}
type Operation = "show" | "status" | "pause" | "resume" | "clear";
export type GoalCommand = { [K in Operation]: { action: K } }[Operation] | { action: "start"; objective: string };
export function parseCommand(args: string): GoalCommand {
  const operation = args.trim();
  if (!operation) return { action: "show" };
  if (["status", "pause", "resume", "clear"].includes(operation)) return { action: operation as "status" | "pause" | "resume" | "clear" };
  // Only the escape separator is removed; the supplied objective itself is never summarized or trimmed.
  return { action: "start", objective: args.startsWith("-- ") ? args.slice(3) : args };
}
