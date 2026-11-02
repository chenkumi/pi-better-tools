import { agentRules } from './rules/agents.ts';
import { dataRules } from './rules/data.ts';
import { execRules } from './rules/exec.ts';
import { fileRules } from './rules/files.ts';
import { ptyRules } from './rules/pty.ts';
import { type EntryRef, formatRef } from './ref.ts';
import type { FoldRule, ToolCallInfo, ToolResultInfo } from './types.ts';
import { oneLine, redact, summarizeArgs } from './util.ts';

export type { ToolCallInfo, ToolResultInfo } from './types.ts';

const RULES: Readonly<Record<string, FoldRule>> = Object.freeze({ ...fileRules, ...execRules, ...agentRules, ...ptyRules, ...dataRules });

const DEFAULT_ERROR_MAX = 400;
const GENERIC_HEAD = 200;
const GENERIC_TAIL = 100;

/** Tool names with a dedicated rule. Everything else is folded by the generic fallback. */
export const registeredToolNames = (): string[] => Object.keys(RULES).sort();
export const hasRule = (name: string): boolean => Object.hasOwn(RULES, name);

const recall = (ref: EntryRef | undefined) => (ref ? ` ${formatRef(ref)}` : '');
const line = (label: string, args: string, outcome: string, ref: EntryRef | undefined) =>
  `[${label}]${args ? ` ${args}` : ''} → ${outcome}${recall(ref)}`;

function errorOutcome(text: string, max: number): string {
  return `ERROR: ${oneLine(redact(text), max)}`;
}

/** Fold used for a tool without a rule, and for a result whose call cannot be found. Keeps the head and tail of the output. */
function genericOutcome(result: ToolResultInfo): string {
  const text = result.text.replace(/\s+/g, ' ').trim();
  if (text.length <= GENERIC_HEAD + GENERIC_TAIL) return oneLine(redact(text), GENERIC_HEAD + GENERIC_TAIL + 1) || '(empty)';
  return `${oneLine(redact(text.slice(0, GENERIC_HEAD)), GENERIC_HEAD)} … ${oneLine(redact(text.slice(-GENERIC_TAIL)), GENERIC_TAIL)} (${text.length} chars)`;
}

/**
 * One folded line for a paired tool call. A failed call keeps a bounded excerpt of its error, because the error is often the
 * reason for the next decision. A rule that throws on an unexpected shape falls back to the generic fold, never to the raw text.
 */
export function foldToolUse(call: ToolCallInfo, result: ToolResultInfo): string {
  const rule = hasRule(call.name) ? RULES[call.name] : undefined;
  if (!rule) {
    const args = summarizeArgs(call.args);
    return line(call.name, args, result.isError ? errorOutcome(result.text, DEFAULT_ERROR_MAX) : genericOutcome(result), result.ref);
  }
  const label = rule.label ?? call.name;
  let args = '';
  try { args = rule.args(call); } catch { args = summarizeArgs(call.args); }
  const mode = rule.errors ?? 'text';
  if (result.isError && mode !== 'own') {
    return line(label, args, mode === 'hidden' ? 'failed (details hidden)' : errorOutcome(result.text, rule.errorMax ?? DEFAULT_ERROR_MAX), result.ref);
  }
  try {
    return line(label, args, oneLine(rule.ok(call, result), 1200), result.ref);
  } catch {
    return line(label, args, result.isError ? errorOutcome(result.text, DEFAULT_ERROR_MAX) : genericOutcome(result), result.ref);
  }
}

/** A call whose result never arrived (interrupted run). */
export function foldUnpairedCall(call: ToolCallInfo, ref?: EntryRef): string {
  const rule = hasRule(call.name) ? RULES[call.name] : undefined;
  let args = '';
  try { args = rule ? rule.args(call) : summarizeArgs(call.args); } catch { args = summarizeArgs(call.args); }
  return line(rule?.label ?? call.name, args, 'no result recorded', ref);
}

/** A result whose call is not in the folded range. It is never trusted as a success: the generic fold marks it unpaired. */
export function foldUnpairedResult(name: string, result: ToolResultInfo): string {
  return line(name, '', `(unpaired) ${result.isError ? errorOutcome(result.text, DEFAULT_ERROR_MAX) : genericOutcome(result)}`, result.ref);
}
