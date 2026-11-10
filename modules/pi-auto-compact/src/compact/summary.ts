import type { AutoCompactConfig } from '../config.ts';
import { checkpointBody, isCheckpointCall } from '../checkpoint/mark.ts';
import { formatRef } from '../fold/ref.ts';
import { asRecord, str } from '../fold/util.ts';
import type { Entry, Item } from './items.ts';
import { budgetsFor, chooseLayout, firstVisible, type Layout } from './layout.ts';
import { length, renderL2, renderL3 } from './render.ts';
import { goalLine, stateLines } from './state.ts';

export const COMPACTOR_ID = 'pi-auto-compact';
export const DETAILS_VERSION = 1;

export interface CompactionDetails {
  compactor: typeof COMPACTOR_ID;
  version: typeof DETAILS_VERSION;
  /** First entry shown in the summary. The next compaction keeps it as the window start until the L4 slack is full. */
  windowStart?: { entryId: string; line?: number; sessionId?: string };
  stats: {
    items: number;
    shownConversation: number;
    shownActivity: number;
    notShown: number;
    conversationChars: number;
    activityChars: number;
    keptChars: number;
    estimatedTokens: number;
    /** Which part of the total guard had to act: nothing, the L4 slack (window start reset), L3, or L2. */
    guard: 'none' | 'l4' | 'l3' | 'l2';
    windowStartKept: boolean;
    /** How many entries the cut moved later than Pi's to keep the raw tail within its budget (0 = Pi's cut). */
    cutMoved: number;
    /** L1 budget the raw tail left unused, added to the L2 budget for this compaction. */
    l2Lent: number;
  };
}

export interface SummaryInput {
  items: readonly Item[];
  config: AutoCompactConfig;
  /** Model context window in tokens. */
  contextWindow: number;
  /** Estimated characters of what Pi keeps after the cut (L1), counted against the total ceiling. */
  keptChars: number;
  sessionId?: string;
  /** Working directory; paths inside it are shown relative to it. */
  cwd?: string;
  /** Window start recorded by the previous compaction of this engine, if any. */
  previousStartEntryId?: string;
  /** Blocks describing the moment of compaction (jobs, monitors, working tree). Always last, because they change every time. */
  volatile?: readonly string[];
  /** How many entries the cut was moved later than Pi's cut. */
  cutMoved?: number;
  /** A checkpoint call lies after the cut (Pi keeps it as a raw message), so an older one is not shown as the latest. */
  checkpointInTail?: boolean;
}

export interface SummaryResult { summary: string; details: CompactionDetails }

/** The window start the previous compaction recorded, or undefined when the latest compaction was not made by this engine. */
export function previousWindowStart(branch: readonly Entry[]): string | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    if (branch[i]!.type !== 'compaction') continue;
    const details = asRecord(branch[i]!.details);
    return details?.compactor === COMPACTOR_ID && details.version === DETAILS_VERSION ? str(asRecord(details.windowStart)?.entryId) : undefined;
  }
  return undefined;
}

/**
 * The summary's first lines. Constant text plus the window start, so they only change when the start moves. They must never
 * carry counts, sizes or times.
 */
function header(first: Item | undefined, whole: boolean, sessionId: string | undefined): string[] {
  const tools = 'read a line with session_read, search with session_grep, outline a range with session_window (load them with tool_search)';
  if (!first?.ref || !sessionId) return [whole ? 'The whole earlier conversation is shown below, newest last.' : 'Earlier conversation is shown below, newest last; entries older than the first one shown are not available.'];
  const mark = formatRef({ line: first.ref.line, id: first.ref.id });
  return whole
    ? [`Session ${sessionId}: the whole earlier conversation is shown below, newest last. ⟦L<line>:<id>⟧ marks a line of the session file: ${tools}.`]
    : [`Session ${sessionId}: older conversation is not shown. History below starts at ${mark}; older entries: session_window before=${first.ref.line}. ⟦L<line>:<id>⟧ marks a line of the session file: ${tools}.`];
}

/** Estimated characters the summary spends on fixed text, for the total ceiling only: the header block, and each section title with its blank line. */
const HEADER_RESERVE = 600;
const STATE_TITLE_CHARS = 24;
const EARLIER_TITLE_CHARS = 28;
const RECENT_TITLE_CHARS = 24;
/** The latest checkpoint before the cut: its full text and the item that holds the call. */
function latestCheckpoint(items: readonly Item[]): { body: string; item: Item } | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    for (const { call, result } of [...items[i]!.calls].reverse()) {
      const body = isCheckpointCall(call.name) && result && !result.isError ? checkpointBody(call.args).trim() : '';
      if (body) return { body, item: items[i]! };
    }
  }
  return undefined;
}

/**
 * The latest checkpoint in full, as its own section (older ones are single titled lines in the conversation sections). A text
 * longer than `max` keeps its head and its tail with the omitted size in between; the original stays readable with session_read.
 */
function checkpointSection(found: { body: string; item: Item }, max: number): string[] {
  const ref = found.item.ref ? formatRef(found.item.ref) : undefined;
  const { body } = found;
  const text = body.length <= max ? body : `${body.slice(0, Math.floor(max * 0.6))}
[… ${body.length - max} chars omitted${ref ? `; the whole text: session_read ${ref}` : ''} …]
${body.slice(body.length - (max - Math.floor(max * 0.6)))}`;
  return [`## Latest checkpoint${ref ? ` ${ref}` : ''}`, text];
}

/** A volatile block is preceded by one blank line. */
const BLOCK_SEPARATOR_CHARS = 2;

type Guard = CompactionDetails['stats']['guard'];

/**
 * Applies the total ceiling to the section starts chosen by `chooseLayout`. In order: the recorded window start is dropped (the
 * L4 slack resets to the nominal L3 start), then L3 loses its oldest items, then L2 does. L1 is never touched. `total` is the
 * estimated summary size for a given pair of section starts.
 */
function enforceCeiling(layout: Layout, lens3: readonly number[], n: number, limit: number, total: (l3Start: number, l2Start: number) => number) {
  let { l2Start, l3Start } = layout, keptStart = layout.keptStart, guard: Guard = 'none';
  const over = () => total(l3Start, l2Start) > limit;
  if (over() && keptStart) { l3Start = layout.nominalStart; keptStart = false; guard = 'l4'; }
  while (over() && l3Start < l2Start) { l3Start = firstVisible(lens3, l3Start + 1, l2Start); guard = 'l3'; }
  while (over() && l2Start < n) { l2Start++; l3Start = Math.max(l3Start, l2Start); guard = 'l2'; }
  return { l2Start, l3Start, keptStart, guard };
}

/**
 * Builds the compaction summary from the items before Pi's cut. Pure: the same input gives the same bytes.
 *
 * Layout, oldest first: header, goal, earlier conversation (L3 plus its L4 slack), recent activity (L2), the latest checkpoint,
 * the state block, then the volatile blocks at the very end. Whatever Pi keeps after the cut (L1) stays as raw messages and is not part of the summary.
 */
export function composeSummary(input: SummaryInput): SummaryResult {
  const { items, config, contextWindow } = input;
  const n = items.length;
  // A user message is shown whole up to half of its section's configured budget (never the borrowed part, so rendering does not
  // depend on how full L1 was); longer ones keep head and tail.
  const budgets = budgetsFor(config, contextWindow);
  const rendered2 = items.map(item => renderL2(item, Math.floor(budgets.l2 / 2)));
  const rendered3 = items.map(item => renderL3(item, Math.floor(budgets.l3 / 2)));
  const lens2 = rendered2.map(lines => length(lines));
  const lens3 = rendered3.map(line => (line === undefined ? 0 : line.length + 1));
  const previousIdx = input.previousStartEntryId ? items.findIndex(item => item.entryId === input.previousStartEntryId) : -1;
  // The raw tail (L1) rarely fills its budget (a parallel batch of large results cannot be split); what it leaves is lent to L2,
  // so L1 + L2 stays near `l1 + l2` however full L1 is. The worst case total does not change.
  const l2Lent = Math.max(0, budgets.l1 - input.keptChars);
  const layout = chooseLayout(lens2, lens3, { ...budgets, l2: budgets.l2 + l2Lent }, previousIdx);

  const goal = goalLine(items), state = stateLines(items, input.cwd);
  const found = input.checkpointInTail ? undefined : latestCheckpoint(items);
  const checkpoint = found ? checkpointSection(found, budgets.l2) : [];
  const volatile = (input.volatile ?? []).filter(block => block.length > 0);
  const fixed = HEADER_RESERVE + length(checkpoint) + (checkpoint.length ? BLOCK_SEPARATOR_CHARS : 0) + (goal ? goal.length + 1 : 0) + length(state) + (state.length ? STATE_TITLE_CHARS : 0) + volatile.reduce((sum, block) => sum + block.length + BLOCK_SEPARATOR_CHARS, 0);
  const sectionTitles = (l3: boolean, l2: boolean) => (l3 ? EARLIER_TITLE_CHARS : 0) + (l2 ? RECENT_TITLE_CHARS : 0);
  const prefix = (lens: readonly number[]) => { const out = [0]; for (const value of lens) out.push(out[out.length - 1]! + value); return out; };
  const pre2 = prefix(lens2), pre3 = prefix(lens3);
  const total = (l3Start: number, l2Start: number) => fixed + sectionTitles(l3Start < l2Start, l2Start < n) + (pre3[l2Start]! - pre3[l3Start]!) + (pre2[n]! - pre2[l2Start]!) + input.keptChars;
  const limit = config.maxTotalRatio * contextWindow * config.charsPerToken;
  const { l2Start, l3Start, keptStart, guard } = enforceCeiling(layout, lens3, n, limit, total);

  const firstShownIdx = l3Start < l2Start ? l3Start : l2Start < n ? l2Start : -1;
  const firstShown = firstShownIdx >= 0 ? items[firstShownIdx] : undefined;
  const out = [...header(firstShown, firstShownIdx === 0, input.sessionId)];
  if (goal) out.push('', goal);
  if (l3Start < l2Start) { out.push('', '## Earlier conversation'); for (let i = l3Start; i < l2Start; i++) if (rendered3[i] !== undefined) out.push(rendered3[i]!); }
  if (l2Start < n) { out.push('', '## Recent activity'); for (let i = l2Start; i < n; i++) out.push(...rendered2[i]!); }
  if (checkpoint.length) out.push('', ...checkpoint);
  if (state.length) out.push('', '## State at compaction', ...state);
  for (const block of volatile) out.push('', block);

  const keptTotal = total(l3Start, l2Start);
  return {
    summary: out.join('\n'),
    details: {
      compactor: COMPACTOR_ID, version: DETAILS_VERSION,
      ...(firstShown ? { windowStart: { entryId: firstShown.entryId, ...(firstShown.ref ? { line: firstShown.ref.line } : {}), ...(input.sessionId ? { sessionId: input.sessionId } : {}) } } : {}),
      stats: {
        items: n, shownConversation: Math.max(0, l2Start - l3Start), shownActivity: n - l2Start, notShown: l3Start,
        conversationChars: pre3[l2Start]! - pre3[l3Start]!, activityChars: pre2[n]! - pre2[l2Start]!, keptChars: input.keptChars,
        estimatedTokens: Math.round(keptTotal / config.charsPerToken), guard, windowStartKept: keptStart, cutMoved: input.cutMoved ?? 0, l2Lent,
      },
    },
  };
}
