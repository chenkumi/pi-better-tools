import { Type } from 'typebox';
const open = { additionalProperties: true };
/** One Monitor receipt as returned by monitor_start / monitor_status / monitor_stop (undefined fields are dropped by JSON). */
export const receiptSchema = Type.Object({
  monitorId: Type.String(),
  owner: Type.Object({ sessionId: Type.Optional(Type.String()), generation: Type.Number(), cwdScope: Type.String() }, open),
  source: Type.String(),
  wakeAgent: Type.Boolean(),
  label: Type.Optional(Type.String()),
  sourcePreview: Type.String(),
  state: Type.String(),
  stopReason: Type.Optional(Type.String()),
  createdAt: Type.Number(),
  startedAt: Type.Optional(Type.Number()),
  deadline: Type.Number(),
  elapsedMs: Type.Number(),
  counts: Type.Object({ adopted: Type.Number(), submitted: Type.Number(), omitted: Type.Number(), rejected: Type.Number() }, open),
  buffered: Type.Number(),
  bufferedBytes: Type.Number(),
  lastEventAt: Type.Optional(Type.Number()),
  lastSystemEvent: Type.Optional(Type.Object({}, open)),
  cleanupPending: Type.Boolean(),
  cleanupEvidence: Type.Object({}, open),
  notification: Type.Object({ state: Type.String(), attempts: Type.Number() }, open),
  limits: Type.Object({}, open),
  diagnostics: Type.Object({ stderrInputBytes: Type.Number(), stderrTail: Type.String(), stderrTruncated: Type.Boolean() }, open),
}, open);
const failureSchema = Type.Object({ error: Type.String(), code: Type.Optional(Type.String()) }, open);
/** monitor_start / monitor_stop: one receipt (or an in-band `{ error }` when the call is rejected). */
export const receiptOutputSchema = Type.Union([receiptSchema, failureSchema]);
/** monitor_status: one receipt, a `{ monitors }` list when monitorId is omitted, or an in-band `{ error }`. */
export const statusOutputSchema = Type.Union([receiptSchema, Type.Object({ monitors: Type.Array(receiptSchema) }, open), failureSchema]);
