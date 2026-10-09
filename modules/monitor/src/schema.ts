import { Type, type Static } from 'typebox';
const object = { additionalProperties: false };
export const startSchema = Type.Object({
  source: Type.Union([
    Type.Object({ kind: Type.Literal('command'), tool: Type.Union([Type.Literal('bash'), Type.Literal('powershell')]), command: Type.String({ minLength: 1, maxLength: 65536 }) }, object),
    Type.Object({ kind: Type.Literal('websocket'), url: Type.String({ minLength: 1, maxLength: 8192 }), allowPrivateNetwork: Type.Optional(Type.Boolean()), allowInsecure: Type.Optional(Type.Boolean()) }, object),
    Type.Object({ kind: Type.Literal('shell_job'), jobId: Type.String({ minLength: 1, maxLength: 128 }), intervalMs: Type.Optional(Type.Integer({ minimum: 30000, maximum: 300000 })) }, object),
    Type.Object({ kind: Type.Literal('subagent_job'), jobId: Type.String({ minLength: 1, maxLength: 128 }), intervalMs: Type.Optional(Type.Integer({ minimum: 30000, maximum: 300000 })) }, object),
  ]),
  durationMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 1800000 })),
  wakeAgent: Type.Optional(Type.Boolean()), stopAfterEvents: Type.Optional(Type.Integer({ minimum: 1, maximum: 600 })),
  label: Type.Optional(Type.String({ maxLength: 80 })),
}, object);
export type Start = Static<typeof startSchema> & { durationMs: number; wakeAgent: boolean };
export function plainText(value: string): string { return value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ''); }
function record(v: unknown): asserts v is Record<string, unknown> { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Expected an object'); }
function keys(v: Record<string, unknown>, allowed: string[]) { if (Object.keys(v).some(k => !allowed.includes(k))) throw new Error('Unknown Monitor parameter'); }
function integer(v: unknown, min: number, max: number) { if (!Number.isSafeInteger(v) || (v as number) < min || (v as number) > max) throw new Error(`Expected integer ${min}–${max}`); }
function text(v: unknown, max: number) { if (typeof v !== 'string' || v.length === 0 || [...v].length > max) throw new Error(`Expected bounded text (1–${max} characters)`); }
/** Direct execution must not depend on host argument validation being present. */
export function validateStart(value: unknown): Start {
  record(value); keys(value, ['source', 'durationMs', 'wakeAgent', 'stopAfterEvents', 'label']); record(value.source);
  const s = value.source;
  switch (s.kind) {
    case 'command': keys(s, ['kind', 'tool', 'command']); if (s.tool !== 'bash' && s.tool !== 'powershell') throw new Error('Unsupported shell backend'); text(s.command, 65536); if (Buffer.byteLength(s.command as string) > 65536) throw new Error('Command exceeds 64 KiB'); break;
    case 'websocket': keys(s, ['kind', 'url', 'allowPrivateNetwork', 'allowInsecure']); text(s.url, 8192); for (const k of ['allowPrivateNetwork', 'allowInsecure']) if (s[k] !== undefined && typeof s[k] !== 'boolean') throw new Error('Network opt-ins must be explicit booleans'); break;
    case 'shell_job': case 'subagent_job': keys(s, ['kind', 'jobId', 'intervalMs']); text(s.jobId, 128); if (s.intervalMs !== undefined) integer(s.intervalMs, 30000, 300000); break;
    default: throw new Error('Unsupported Monitor source');
  }
  if (value.durationMs !== undefined) integer(value.durationMs, 1000, 1800000);
  if (value.stopAfterEvents !== undefined) integer(value.stopAfterEvents, 1, 600);
  if (value.wakeAgent !== undefined && typeof value.wakeAgent !== 'boolean') throw new Error('wakeAgent must be boolean');
  if (value.label !== undefined && (typeof value.label !== 'string' || [...value.label].length > 80 || Buffer.byteLength(value.label) > 320)) throw new Error('label must be at most 80 characters');
  return { ...value, source: { ...s }, ...(typeof value.label === 'string' ? { label: plainText(value.label) } : {}), durationMs: value.durationMs ?? 300000, wakeAgent: value.wakeAgent ?? true } as Start;
}
