import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const BACKENDS = ['openai', 'gemini', 'codex'] as const;
export type Backend = (typeof BACKENDS)[number];
export const BACKEND_LABELS: Record<Backend, string> = { openai: 'OpenAI', gemini: 'Gemini', codex: 'Codex CLI' };
export const CONFIRM_MODES = ['first', 'always', 'never'] as const;
export type ConfirmMode = (typeof CONFIRM_MODES)[number];
export const OPENAI_QUALITIES = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export const OPENAI_FORMATS = ['png', 'jpeg', 'webp'] as const;
export const RESOLUTIONS = ['1K', '2K', '4K'] as const;
export const MAX_IMAGES_RANGE = { min: 1, max: 10 } as const;
export const TIMEOUT_MS_RANGE = { min: 10_000, max: 600_000 } as const;

export interface Config {
  version: 1;
  /** Master switch. false: the tool is not registered at load and a call is refused. */
  enabled: boolean;
  backend: Backend;
  confirm: ConfirmMode;
  outputDir: string;
  maxImages: number;
  inlinePreview: boolean;
  timeoutMs: number;
  openai: { enabled: boolean; model: string; quality: (typeof OPENAI_QUALITIES)[number]; format: (typeof OPENAI_FORMATS)[number] };
  gemini: { enabled: boolean; model: string; resolution: (typeof RESOLUTIONS)[number] };
  codex: { enabled: boolean; path: string; model?: string; timeoutMs: number };
}

/** Explicit override only (tests); changing pi's agentDir must not silently move a user-level file. */
export const CONFIG_PATH = process.env.PI_IMAGE_GENERATION_CONFIG ?? join(homedir(), '.pi', 'agent', 'image-generation.json');

export const defaults = (): Config => ({
  version: 1, enabled: false, backend: 'openai', confirm: 'first', outputDir: '.pi/generated-images', maxImages: 4, inlinePreview: false, timeoutMs: 180_000,
  openai: { enabled: true, model: 'gpt-image-2.6-sunburst', quality: 'auto', format: 'png' },
  gemini: { enabled: true, model: 'gemini-nano-banana-2.1', resolution: '1K' },
  codex: { enabled: true, path: 'codex', timeoutMs: 300_000 },
});

/** `path` names the field; `rule` states what is allowed. Received values are never echoed. */
function invalid(path: string, rule: string): never { throw new Error(`CONFIG_INVALID: ${path}: ${rule}`); }
function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path, 'must be a JSON object');
  return value as Record<string, unknown>;
}
function keys(o: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(o)) if (!allowed.includes(key)) invalid(path, `unknown field; allowed fields: ${allowed.join(', ')}`);
}
function integer(v: unknown, min: number, max: number, path: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) invalid(path, `must be an integer from ${min} to ${max}`);
  return v;
}
function boolean(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') invalid(path, 'must be true or false');
  return v;
}
function oneOf<T extends string>(v: unknown, values: readonly T[], path: string): T {
  if (typeof v !== 'string' || !values.includes(v as T)) invalid(path, `must be one of: ${values.join(', ')}`);
  return v as T;
}
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
function model(v: unknown, path: string): string {
  if (typeof v !== 'string' || !MODEL_PATTERN.test(v)) invalid(path, 'must be a model id (letters, digits, dot, dash, underscore; up to 100 characters)');
  return v;
}
/** Project-relative directory: no absolute path, no `..`, no drive letter. The tool still checks the real path on every write. */
export function outputDir(v: unknown, path: string): string {
  if (typeof v !== 'string' || !v.trim() || v.length > 200 || /[\0:*?"<>|]/.test(v)) invalid(path, 'must be a relative directory name (up to 200 characters)');
  const parts = v.replace(/\\/g, '/').split('/').filter(part => part !== '' && part !== '.');
  if (v.startsWith('/') || v.startsWith('\\') || !parts.length || parts.includes('..')) invalid(path, 'must stay inside the project (relative, no ..)');
  return parts.join('/');
}
function codexPath(v: unknown, path: string): string {
  if (typeof v !== 'string' || !v.trim() || v.length > 500 || /[\0\r\n]/.test(v)) invalid(path, 'must be an executable name or path');
  if (/\.(cmd|bat)$/i.test(v)) invalid(path, 'must point to the codex executable itself (.exe or a binary), not a .cmd/.bat shim: the prompt is passed as an argument and must not go through a shell');
  return v;
}

export function parseConfig(value: unknown): Config {
  const o = object(value, 'config');
  keys(o, ['version', 'enabled', 'backend', 'confirm', 'outputDir', 'maxImages', 'inlinePreview', 'timeoutMs', 'openai', 'gemini', 'codex'], 'config');
  if (o.version !== undefined && o.version !== 1) invalid('version', 'must be 1');
  const d = defaults();
  const out: Config = { ...d, openai: { ...d.openai }, gemini: { ...d.gemini }, codex: { ...d.codex } };
  if (o.enabled !== undefined) out.enabled = boolean(o.enabled, 'enabled');
  if (o.backend !== undefined) out.backend = oneOf(o.backend, BACKENDS, 'backend');
  if (o.confirm !== undefined) out.confirm = oneOf(o.confirm, CONFIRM_MODES, 'confirm');
  if (o.outputDir !== undefined) out.outputDir = outputDir(o.outputDir, 'outputDir');
  if (o.maxImages !== undefined) out.maxImages = integer(o.maxImages, MAX_IMAGES_RANGE.min, MAX_IMAGES_RANGE.max, 'maxImages');
  if (o.inlinePreview !== undefined) out.inlinePreview = boolean(o.inlinePreview, 'inlinePreview');
  if (o.timeoutMs !== undefined) out.timeoutMs = integer(o.timeoutMs, TIMEOUT_MS_RANGE.min, TIMEOUT_MS_RANGE.max, 'timeoutMs');
  if (o.openai !== undefined) {
    const s = object(o.openai, 'openai'); keys(s, ['enabled', 'model', 'quality', 'format'], 'openai');
    if (s.enabled !== undefined) out.openai.enabled = boolean(s.enabled, 'openai.enabled');
    if (s.model !== undefined) out.openai.model = model(s.model, 'openai.model');
    if (s.quality !== undefined) out.openai.quality = oneOf(s.quality, OPENAI_QUALITIES, 'openai.quality');
    if (s.format !== undefined) out.openai.format = oneOf(s.format, OPENAI_FORMATS, 'openai.format');
  }
  if (o.gemini !== undefined) {
    const s = object(o.gemini, 'gemini'); keys(s, ['enabled', 'model', 'resolution'], 'gemini');
    if (s.enabled !== undefined) out.gemini.enabled = boolean(s.enabled, 'gemini.enabled');
    if (s.model !== undefined) out.gemini.model = model(s.model, 'gemini.model');
    if (s.resolution !== undefined) out.gemini.resolution = oneOf(s.resolution, RESOLUTIONS, 'gemini.resolution');
  }
  if (o.codex !== undefined) {
    const s = object(o.codex, 'codex'); keys(s, ['enabled', 'path', 'model', 'timeoutMs'], 'codex');
    if (s.enabled !== undefined) out.codex.enabled = boolean(s.enabled, 'codex.enabled');
    if (s.path !== undefined) out.codex.path = codexPath(s.path, 'codex.path');
    if (s.model !== undefined && s.model !== null) out.codex.model = model(s.model, 'codex.model');
    if (s.timeoutMs !== undefined) out.codex.timeoutMs = integer(s.timeoutMs, TIMEOUT_MS_RANGE.min, TIMEOUT_MS_RANGE.max, 'codex.timeoutMs');
  }
  return out;
}

/** A missing file is the defaults; an unreadable or invalid file throws `CONFIG_INVALID` (never with the file's values). */
export function loadConfig(path = CONFIG_PATH): Config {
  if (!existsSync(path)) return defaults();
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`CONFIG_INVALID: ${path}: not readable as JSON`); }
  return parseConfig(raw);
}
