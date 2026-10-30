import { Type } from 'typebox';
const object = { additionalProperties: false };
/** Sampling bounds and defaults (ms); shared by the host-facing schema and direct-call validation. */
export const JOB_INTERVAL = { minimum: 30000, maximum: 300000, default: 60000 } as const;
export const FILE_INTERVAL = { minimum: 1000, maximum: 60000, default: 2000 } as const;
export const SYSTEM_INTERVAL = { minimum: 1000, maximum: 60000, default: 1000 } as const;
export const SYSTEM_SUSTAIN = { minimum: 1000, maximum: 1800000 } as const;
const SYSTEM_THRESHOLD = { minimum: 1, maximum: 100 } as const;
const DURATION = { minimum: 1000, maximum: 1800000, default: 300000 } as const;
const STOP_AFTER_EVENTS = { minimum: 1, maximum: 600 } as const;
const range = ({ minimum, maximum }: { minimum: number; maximum: number }, unit = ' ms') => `${minimum}–${maximum}${unit}`;
/**
 * The host-facing shape is deliberately flat: a TypeBox union of the seven sources answers one out-of-range value with
 * six branch failures ("schema is false", "must be equal to constant"), which states neither the cause nor the fix.
 * Per-kind requirements and every bound live in `validateStart`, the single strict layer, whose messages name the
 * parameter, the accepted values and what to change.
 */
export const startSchema = Type.Object({
  source: Type.Object({
    // A plain string, not a literal union: validateStart answers an unknown kind with the list of valid kinds instead of six branch failures.
    kind: Type.String({ description: 'one of: command | websocket | shell_job | subagent_job | fork_job | file | system' }),
    tool: Type.Optional(Type.String({ description: 'command only: "bash" or "powershell"' })),
    command: Type.Optional(Type.String({ description: 'command only: shell command text, at most 64 KiB' })),
    url: Type.Optional(Type.String({ description: 'websocket only: ws:// or wss:// without userinfo, at most 8192 characters' })),
    jobId: Type.Optional(Type.String({ description: 'shell_job | subagent_job | fork_job only: job id returned when that job started' })),
    path: Type.Optional(Type.String({ description: 'file only: file inside the canonical workspace, at most 1024 characters' })),
    metric: Type.Optional(Type.String({ description: 'system only: "cpu" or "ram" (whole-host utilisation, not one process)' })),
    thresholdPercent: Type.Optional(Type.Integer({ description: `system only: notify when utilisation is at or above this percent, ${range(SYSTEM_THRESHOLD, '')}` })),
    sustainMs: Type.Optional(Type.Integer({ description: `system only: utilisation must stay at or above the threshold continuously this long, ${range(SYSTEM_SUSTAIN)}, and below durationMs` })),
    intervalMs: Type.Optional(Type.Integer({ description: `job sources ${range(JOB_INTERVAL)} (default ${JOB_INTERVAL.default}); file ${range(FILE_INTERVAL)} (default ${FILE_INTERVAL.default}); system ${range(SYSTEM_INTERVAL)} (default ${SYSTEM_INTERVAL.default})` })),
    allowPrivateNetwork: Type.Optional(Type.Boolean({ description: 'websocket only: explicit opt-in for private/loopback addresses' })),
    allowInsecure: Type.Optional(Type.Boolean({ description: 'websocket only: required for plain ws:// (not wss://)' })),
  }, object),
  durationMs: Type.Optional(Type.Integer({ description: `total lifetime ${range(DURATION)} including startup, default ${DURATION.default}` })),
  wakeAgent: Type.Optional(Type.Boolean({ description: 'true (default) requests a model turn; false saves the batch for the next turn without rendering it' })),
  stopAfterEvents: Type.Optional(Type.Integer({ description: 'stop after 1–600 adopted data events' })),
  label: Type.Optional(Type.String({ description: 'display label, at most 80 characters' })),
}, object);
export type MonitorSource =
  | { kind: 'command'; tool: 'bash' | 'powershell'; command: string }
  | { kind: 'websocket'; url: string; allowPrivateNetwork?: boolean; allowInsecure?: boolean }
  | { kind: 'shell_job' | 'subagent_job' | 'fork_job'; jobId: string; intervalMs?: number }
  | { kind: 'file'; path: string; intervalMs?: number }
  | { kind: 'system'; metric: 'cpu' | 'ram'; thresholdPercent: number; sustainMs: number; intervalMs?: number };
export type Start = { source: MonitorSource; durationMs: number; wakeAgent: boolean; stopAfterEvents?: number; label?: string };
/** Direct execution must not depend on host argument validation: monitor_status/monitor_stop take only `monitorId` (1-128 characters). */
export function validateMonitorId(value: unknown, required: boolean, tool: string): { monitorId?: string } {
  record(value, `${tool} arguments`);
  keys(value, ['monitorId'], tool);
  const id = value.monitorId;
  if (id === undefined) { if (required) throw new Error(`${tool}: "monitorId" is required; pass the monitorId returned by monitor_start (list ids with monitor_status)`); return { monitorId: undefined }; }
  if (typeof id !== 'string') throw new Error(`${tool}: "monitorId" must be a string; received ${shown(id)}`);
  if (id.length === 0) throw new Error(`${tool}: "monitorId" must not be empty; pass the monitorId returned by monitor_start${required ? '' : ' or omit it to list monitors'}`);
  if (id.length > 128) throw new Error(`${tool}: "monitorId" is ${id.length} characters, over the 128 limit; pass the monitorId exactly as monitor_start returned it`);
  return { monitorId: id };
}
export function plainText(value: string): string { return value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ''); }
const SOURCE_KINDS = 'command, websocket, shell_job, subagent_job, fork_job, file, system';
const shown = (value: unknown) => { let text: string; try { text = value === undefined ? 'undefined' : JSON.stringify(value) ?? String(value); } catch { text = String(value); } return text.length > 120 ? `${text.slice(0, 120)}…` : text; };
function record(v: unknown, what: string): asserts v is Record<string, unknown> { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${what} must be an object; received ${shown(v)}`); }
function keys(v: Record<string, unknown>, allowed: readonly string[], what: string) {
  const unknown = Object.keys(v).filter(k => !allowed.includes(k));
  if (unknown.length) throw new Error(`Unknown Monitor parameter ${unknown.map(k => JSON.stringify(k)).join(', ')}: ${what} accepts ${allowed.join(', ')}`);
}
function integer(v: unknown, bounds: { minimum: number; maximum: number }, name: string, hint: string, unit = ' ms') {
  if (!Number.isSafeInteger(v) || (v as number) < bounds.minimum || (v as number) > bounds.maximum) throw new Error(`${name} ${shown(v)} is out of range: use an integer ${range(bounds, unit)} (${hint})`);
}
function text(v: unknown, max: number, name: string, hint: string) {
  if (typeof v !== 'string' || v.length === 0) throw new Error(`${name} must be a non-empty string; ${hint}`);
  if ([...v].length > max) throw new Error(`${name} is ${[...v].length} characters, over the ${max} limit; ${hint}`);
}
/** Direct execution must not depend on host argument validation being present. Every message states cause and fix. */
export function validateStart(value: unknown): Start {
  record(value, 'monitor_start arguments');
  keys(value, ['source', 'durationMs', 'wakeAgent', 'stopAfterEvents', 'label'], 'monitor_start');
  record(value.source, 'monitor_start "source"');
  const s = value.source;
  switch (s.kind) {
    case 'command':
      keys(s, ['kind', 'tool', 'command'], 'a command source');
      if (s.tool !== 'bash' && s.tool !== 'powershell') throw new Error(`command source "tool" ${shown(s.tool)} is unsupported: set it to "bash" or "powershell"`);
      text(s.command, 65536, 'command source "command"', 'pass the shell command text to run');
      if (Buffer.byteLength(s.command as string) > 65536) throw new Error(`command source "command" is ${Buffer.byteLength(s.command as string)} bytes, over the 64 KiB limit; shorten it or call a script inside the workspace`);
      break;
    case 'websocket':
      keys(s, ['kind', 'url', 'allowPrivateNetwork', 'allowInsecure'], 'a websocket source');
      text(s.url, 8192, 'websocket source "url"', 'use wss://host/path without userinfo; plain ws:// additionally needs allowInsecure:true');
      for (const k of ['allowPrivateNetwork', 'allowInsecure']) if (s[k] !== undefined && typeof s[k] !== 'boolean') throw new Error(`websocket source "${k}" must be a boolean: true opts in explicitly, false or omitted keeps the default`);
      break;
    case 'shell_job': case 'subagent_job': case 'fork_job': {
      keys(s, ['kind', 'jobId', 'intervalMs'], `a ${s.kind} source`);
      text(s.jobId, 128, `${s.kind} source "jobId"`, 'pass the job id returned when that job started');
      // A job snapshot is a merge of state; sampling faster than 30 s only re-reads the same record.
      if (s.intervalMs !== undefined) integer(s.intervalMs, JOB_INTERVAL, `${s.kind} source "intervalMs"`, `default ${JOB_INTERVAL.default}; job sampling cannot be faster than ${JOB_INTERVAL.minimum} ms`);
      break;
    }
    case 'file':
      keys(s, ['kind', 'path', 'intervalMs'], 'a file source');
      text(s.path, 1024, 'file source "path"', 'point at a file inside the canonical workspace');
      if (plainText(s.path as string) !== s.path) throw new Error('file source "path" must not contain control characters; pass the plain filesystem path');
      if (s.intervalMs !== undefined) integer(s.intervalMs, FILE_INTERVAL, 'file source "intervalMs"', `default ${FILE_INTERVAL.default}`);
      break;
    case 'system':
      keys(s, ['kind', 'metric', 'thresholdPercent', 'sustainMs', 'intervalMs'], 'a system source');
      if (s.metric !== 'cpu' && s.metric !== 'ram') throw new Error(`system source "metric" ${shown(s.metric)} is unsupported: set it to "cpu" or "ram" (one metric per monitor; start a second monitor for the other)`);
      integer(s.thresholdPercent, SYSTEM_THRESHOLD, 'system source "thresholdPercent"', 'notify when whole-host utilisation reaches this percent', '');
      integer(s.sustainMs, SYSTEM_SUSTAIN, 'system source "sustainMs"', 'utilisation must stay at or above the threshold continuously this long before one notification');
      if (s.intervalMs !== undefined) integer(s.intervalMs, SYSTEM_INTERVAL, 'system source "intervalMs"', `default ${SYSTEM_INTERVAL.default}`);
      break;
    default: throw new Error(`source "kind" ${shown(s.kind)} is unsupported: use ${SOURCE_KINDS}`);
  }
  if (value.durationMs !== undefined) integer(value.durationMs, DURATION, '"durationMs"', `default ${DURATION.default}`);
  if (s.kind === 'system' && (s.sustainMs as number) >= ((value.durationMs as number | undefined) ?? DURATION.default)) throw new Error(`system source "sustainMs" ${s.sustainMs} must be below "durationMs" (${(value.durationMs as number | undefined) ?? DURATION.default}${value.durationMs === undefined ? ', the default' : ''}), otherwise the threshold can never be reported: shorten sustainMs or raise durationMs (maximum ${DURATION.maximum})`);
  if (value.stopAfterEvents !== undefined) integer(value.stopAfterEvents, STOP_AFTER_EVENTS, '"stopAfterEvents"', 'counts adopted data events', '');
  if (value.wakeAgent !== undefined && typeof value.wakeAgent !== 'boolean') throw new Error(`"wakeAgent" must be a boolean: true (default) requests a model turn, false saves the batch for the next turn without rendering it; received ${shown(value.wakeAgent)}`);
  if (value.label !== undefined && typeof value.label !== 'string') throw new Error(`"label" must be a string; received ${shown(value.label)}`);
  if (typeof value.label === 'string' && ([...value.label].length > 80 || Buffer.byteLength(value.label) > 320)) throw new Error(`"label" is ${[...value.label].length} characters (${Buffer.byteLength(value.label)} bytes), over the 80 character / 320 byte limit; shorten it or omit label`);
  return { source: { ...s } as MonitorSource, durationMs: (value.durationMs as number | undefined) ?? DURATION.default, wakeAgent: (value.wakeAgent as boolean | undefined) ?? true, ...(value.stopAfterEvents !== undefined ? { stopAfterEvents: value.stopAfterEvents as number } : {}), ...(typeof value.label === 'string' ? { label: plainText(value.label) } : {}) };
}
