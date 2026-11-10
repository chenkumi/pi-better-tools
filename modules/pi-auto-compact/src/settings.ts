import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerSettingsCommand } from '../../../shared/src/settings-panel/index.ts';
import type { Field, Patch, SettingsSchema, Values } from '../../../shared/src/settings-panel/index.ts';
import { budgetsFor } from './compact/layout.ts';
import { configPath, DEFAULT_CONFIG, loadConfig, parseConfig, type AutoCompactConfig } from './config.ts';

/** What the panel works on: the untouched JSON document (to tell "set" from "default") and its validated, defaults-filled form. */
export interface PanelConfig { raw: Record<string, unknown>; config: AutoCompactConfig }

type Key = keyof AutoCompactConfig;
const LAYERS: ReadonlyArray<{ layer: 'l1' | 'l2' | 'l3' | 'l4'; group: string; what: string }> = [
  { layer: 'l1', group: 'L1: recent messages kept as they are', what: 'L1' },
  { layer: 'l2', group: 'L2: tool activity folded to one line each', what: 'L2' },
  { layer: 'l3', group: 'L3: conversation only (your messages and the replies)', what: 'L3' },
  { layer: 'l4', group: 'L4: slack before the L3 window start moves', what: 'L4' },
];

/** Every key of the file, in panel order. Blank means "not in the file", so the module default applies. */
const FIELDS: readonly Field[] = [
  ...LAYERS.flatMap(({ layer, group, what }): Field[] => {
    const ratio = `${layer}Ratio` as Key, min = `${layer}MinChars` as Key;
    return [
      { key: ratio, type: 'string', tab: 'Budgets', group, label: `${what} ratio`, placeholder: String(DEFAULT_CONFIG[ratio]),
        help: `Fraction of the context window (tokens). Default ${DEFAULT_CONFIG[ratio]}. ${what} = the larger of window × ratio and the minimum.` },
      { key: min, type: 'string', tab: 'Budgets', group, label: `${what} minimum characters`, placeholder: String(DEFAULT_CONFIG[min]),
        help: `Default ${DEFAULT_CONFIG[min]}. With the default ratio this minimum is what usually applies.` },
    ];
  }),
  { key: 'maxTotalRatio', type: 'string', tab: 'Limits', group: 'Total size', label: 'Total ceiling', placeholder: String(DEFAULT_CONFIG.maxTotalRatio),
    help: `Share of the window the summary and kept tail may use. Default ${DEFAULT_CONFIG.maxTotalRatio}. Over it L4, L3, then L2 shrink.` },
  { key: 'charsPerToken', type: 'string', tab: 'Limits', group: 'Total size', label: 'Characters per token', placeholder: String(DEFAULT_CONFIG.charsPerToken),
    help: `1 to 8. Default ${DEFAULT_CONFIG.charsPerToken}. Pi assumes 4; code, JSON and Chinese text measure about 2.2.` },
  { key: 'deadlineMarginMinTokens', type: 'string', tab: 'Limits', group: 'Before compaction', label: 'Checkpoint notice margin (minimum tokens)', placeholder: String(DEFAULT_CONFIG.deadlineMarginMinTokens),
    help: `Ask the agent to save a progress checkpoint this many tokens (at least 10% of the window) before Pi compacts. Default ${DEFAULT_CONFIG.deadlineMarginMinTokens}. A window below 200k uses this value; 0 leaves just 10%. The notice never comes earlier than half of Pi's compaction threshold.` },
];
const KEYS = new Set<string>(FIELDS.map(field => field.key));
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/** Reading is the module's own strict loader: unknown keys, wrong types and out-of-range values are errors, never replaced silently. */
function parse(raw: unknown): PanelConfig {
  const parsed = parseConfig(raw);
  if (!parsed.ok) throw new Error(`CONFIG_INVALID: ${parsed.error}`);
  return { raw: raw as Record<string, unknown>, config: parsed.config };
}

function toValues({ raw }: PanelConfig): Values {
  const values: Values = {};
  for (const key of KEYS) values[key] = Object.hasOwn(raw, key) ? String(raw[key]) : '';
  return values;
}

/** A blank field removes the key (default again). Every other value is checked with the module's own rule for that key alone. */
function toPatch(values: Values, dirty: ReadonlySet<string>): Patch[] {
  const patches: Patch[] = [];
  for (const key of dirty) {
    if (!KEYS.has(key)) continue;
    const text = String(values[key] ?? '').trim();
    if (text === '') { patches.push({ path: [key], value: undefined }); continue; }
    if (!NUMBER.test(text)) throw new Error(`CONFIG_INVALID: ${key} must be a number`);
    const value = Number(text);
    const checked = parseConfig({ [key]: value });
    if (!checked.ok) throw new Error(`CONFIG_INVALID: ${checked.error}`);
    patches.push({ path: [key], value });
  }
  return patches;
}

/** The budgets that apply to the current model, from the file as it is on disk now (not from unsaved edits). */
function notice(agentDir: string, contextWindow: number | undefined): string {
  const lead = 'Blank = default.';
  const loaded = loadConfig(agentDir);
  if (!loaded.ok || !contextWindow) return lead;
  const b = budgetsFor(loaded.config, contextWindow);
  return `${lead} Now, at ${contextWindow} tokens: L1 ${b.l1} · L2 ${b.l2} · L3 ${b.l3} · L4 ${b.l4} characters.`;
}

export function autoCompactSettings(agentDir: string, contextWindow?: number): SettingsSchema<PanelConfig> {
  return {
    id: 'auto-compact', title: 'Pi Auto Compact', path: configPath(agentDir), parse, deleteWhenEmpty: true,
    notice: notice(agentDir, contextWindow), fields: FIELDS,
    toValues, toPatch,
    // Compaction, the checkpoint hooks and the system prompt section all read the file on every use.
    appliesWithoutReload: true, afterSave: 'Applies from the next compaction; no reload needed.',
  };
}

/** `/settings:auto-compact`. The file is written only when Save is pressed; loading the extension never touches it. */
export function registerAutoCompactSettings(pi: ExtensionAPI): void {
  registerSettingsCommand(pi, ctx => autoCompactSettings(getAgentDir(), ctx.model?.contextWindow), { id: 'auto-compact', title: 'Pi Auto Compact' });
}
