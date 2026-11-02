import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Parameters of the deterministic compaction. The file is user-level only (`<agentDir>/auto-compact.json`), is read and
 * never written by this module, and carries no on/off switch: whether the engine runs is decided by whether the
 * extension entry is mounted.
 */
export interface AutoCompactConfig {
  /** L1 budget = max(ctx × l1Ratio, l1MinChars) characters; ctx is the model context window in tokens. */
  l1Ratio: number;
  l1MinChars: number;
  l2Ratio: number;
  l2MinChars: number;
  l3Ratio: number;
  l3MinChars: number;
  /** Characters per token used to estimate the total. Pi's own estimate is 4; Chinese-heavy sessions measure about 2.2. */
  charsPerToken: number;
  /** Hard ceiling on the estimated summary size as a fraction of the context window; L3 shrinks first, then L2, never L1. */
  maxTotalRatio: number;
}

export const DEFAULT_CONFIG: Readonly<AutoCompactConfig> = Object.freeze({
  l1Ratio: 0.3, l1MinChars: 30_000,
  l2Ratio: 0.2, l2MinChars: 20_000,
  l3Ratio: 0.1, l3MinChars: 10_000,
  charsPerToken: 2.2,
  maxTotalRatio: 0.5,
});

export const CONFIG_FILE_NAME = 'auto-compact.json';
export const configPath = (agentDir: string) => join(agentDir, CONFIG_FILE_NAME);

type Rule = { kind: 'ratio' } | { kind: 'chars' } | { kind: 'range'; min: number; max: number };
const RULES: Record<keyof AutoCompactConfig, Rule> = {
  l1Ratio: { kind: 'ratio' }, l2Ratio: { kind: 'ratio' }, l3Ratio: { kind: 'ratio' }, maxTotalRatio: { kind: 'ratio' },
  l1MinChars: { kind: 'chars' }, l2MinChars: { kind: 'chars' }, l3MinChars: { kind: 'chars' },
  charsPerToken: { kind: 'range', min: 1, max: 8 },
};

function problem(key: string, rule: Rule, value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return `${key} must be a finite number`;
  if (rule.kind === 'ratio') return value > 0 && value <= 1 ? undefined : `${key} must be greater than 0 and at most 1`;
  if (rule.kind === 'chars') return Number.isInteger(value) && value > 0 ? undefined : `${key} must be a positive integer`;
  return value >= rule.min && value <= rule.max ? undefined : `${key} must be between ${rule.min} and ${rule.max}`;
}

export type LoadedConfig = { ok: true; config: AutoCompactConfig; source: 'default' | 'file' } | { ok: false; error: string };

/** Pure validation of a parsed JSON value. Unknown keys and wrong types are errors; there is no fallback to other values. */
export function parseConfig(raw: unknown): LoadedConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'the file must contain one JSON object' };
  const input = raw as Record<string, unknown>;
  const unknown = Object.keys(input).filter(key => !(key in RULES));
  if (unknown.length) return { ok: false, error: `unknown key${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}` };
  const config: AutoCompactConfig = { ...DEFAULT_CONFIG };
  for (const key of Object.keys(RULES) as Array<keyof AutoCompactConfig>) {
    if (!(key in input)) continue;
    const message = problem(key, RULES[key], input[key]);
    if (message) return { ok: false, error: message };
    config[key] = input[key] as number;
  }
  return { ok: true, config, source: 'file' };
}

/** Reads `<agentDir>/auto-compact.json`. A missing file means defaults; an unreadable or invalid file is reported, never silently replaced. */
export function loadConfig(agentDir: string): LoadedConfig {
  const path = configPath(agentDir);
  if (!existsSync(path)) return { ok: true, config: { ...DEFAULT_CONFIG }, source: 'default' };
  let text: string;
  try { text = readFileSync(path, 'utf8'); }
  catch (error) { return { ok: false, error: `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}` }; }
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch { return { ok: false, error: `${path} is not valid JSON` }; }
  const parsed = parseConfig(raw);
  return parsed.ok ? parsed : { ok: false, error: `${path}: ${parsed.error}` };
}
