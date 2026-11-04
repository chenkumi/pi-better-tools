import { DEFAULT_CONFIG } from '../config.ts';

/**
 * Pure state of the progress checkpoint. A long run of tool calls with no assistant text leaves the compactor nothing to anchor
 * on (no conversation lines, no clean cut), so once the context has grown by `ratio × contextWindow` since the last assistant
 * text the run is asked for one short report, but only while the context is larger than `minTokens` (a long-context safeguard; 0 turns it off). If the run then ends right after the report, it is asked once to continue.
 * Every continuation belongs to exactly one checkpoint request, so it cannot repeat on its own and needs no cap.
 *
 * A second trigger, the deadline, serves compaction itself: shortly before Pi's compaction threshold the run is told that
 * compaction is near and is guided to save its progress to a notes file (behavior guidance: the agent decides what to write, and
 * updates a notes file that already exists). It is sent once per compaction cycle, when the context size the provider reported
 * reaches the margin before Pi's threshold, and not when that size is already over the threshold (Pi compacts right after such a
 * response, so there is nothing left to guide). It is skipped when the agent has no way to write a file.
 */
export interface TurnFacts {
  /** Pi's context estimate after this turn (the last reported usage plus an estimate of what came after it), or null when unknown (right after a compaction). */
  tokens: number | null;
  /** Context tokens the provider reported for this turn's response; absent when it reported none (error, abort, no usage). The deadline prefers it over `tokens`. */
  reportedTokens?: number | null;
  contextWindow: number;
  /** The assistant message of this turn carried non-empty text. */
  hasText: boolean;
  /** The turn called the anchor tool (a progress report that is itself a tool call). */
  anchored: boolean;
  /** Tool calls of the turn other than the anchor. */
  toolCalls: number;
  /** Context tokens above which Pi compacts before its next response; absent or null when unknown or compaction is off. */
  threshold?: number | null;
  /** The agent has a tool that can write a notes file; the deadline is skipped without one. Absent means yes. */
  canWrite?: boolean;
  /** Floor of the deadline margin in tokens (`deadlineMarginMinTokens`); absent means the module default. */
  marginMinTokens?: number;
}

/** How early before the threshold the deadline notice is sent: a share of the context window (plan §13.5 #1: not of L1), but never less than a floor, so a small window still leaves room for a large single turn. */
export const DEADLINE_MARGIN_RATIO = 0.1;
export const deadlineMargin = (contextWindow: number, minTokens: number = DEFAULT_CONFIG.deadlineMarginMinTokens): number => Math.max(DEADLINE_MARGIN_RATIO * contextWindow, minTokens);
export type TurnAction = 'none' | 'checkpoint' | 'deadline';

export interface Tracker {
  /** A new user request starts a new count. */
  reset(): void;
  /** A session starts (new, resumed or forked): everything is forgotten, including that the deadline notice was sent. */
  restart(): void;
  /** A compaction lowers the context; the next known size becomes the base, and the deadline may be sent again. */
  compacted(): void;
  /** `minTokens`: the interval checkpoint only applies above this many context tokens (0 turns it off); the deadline is not affected. Default 1: no minimum. */
  turnEnd(facts: TurnFacts, ratio: number, minTokens?: number): TurnAction;
  /** The run is about to end: true when it should be asked to continue (once per request). */
  shouldContinue(): boolean;
}

export function createTracker(): Tracker {
  let base: number | null = null;
  let requested = false;
  let reported = false;
  /** The deadline notice was sent in this compaction cycle; not reset by a user message, the context did not shrink. */
  let deadlineSent = false;
  /** The deadline notice is not answered yet: the first later turn without tool calls is its answer. */
  let deadlineOpen = false;
  const reset = () => { base = null; requested = false; reported = false; deadlineOpen = false; };
  return {
    reset,
    restart() { reset(); deadlineSent = false; },
    compacted() { base = null; requested = false; deadlineSent = false; deadlineOpen = false; },
    turnEnd({ tokens, reportedTokens, contextWindow, hasText, anchored, toolCalls, threshold, canWrite, marginMinTokens }, ratio, minTokens = 1) {
      const answering = deadlineOpen;
      // The notice stays open across turns that call tools (the agent may first save its notes with one); the first turn without tool calls answers it.
      if (toolCalls === 0) deadlineOpen = false;
      // The deadline is decided first and does not depend on text: the notice is about saving notes, not a report that text could replace.
      // It goes by the size the provider reported (what Pi itself compares with its threshold after a response); Pi's estimate
      // only stands in when none was reported.
      const used = reportedTokens ?? tokens;
      if (used !== null && contextWindow > 0 && toolCalls > 0 && !deadlineSent && canWrite !== false && threshold != null) {
        // The zone never starts below half of the threshold, so a small window (or a huge floor) cannot make the notice fire on the first turn.
        const zone = Math.max(threshold - deadlineMargin(contextWindow, marginMinTokens), threshold / 2);
        if (used >= zone && used < threshold) { deadlineSent = true; deadlineOpen = true; base = used; requested = false; reported = false; return 'deadline'; }
      }
      if (hasText || anchored) {
        base = tokens;
        // A text-only answer may end the run, so it is followed by one continuation request; an anchor call always returns to the model.
        reported = (requested || answering) && !anchored && toolCalls === 0;
        requested = false;
        return 'none';
      }
      if (toolCalls > 0) reported = false;
      if (tokens === null || !(contextWindow > 0)) return 'none';
      if (base === null || tokens < base) { base = tokens; return 'none'; }
      if (minTokens <= 0 || tokens <= minTokens || toolCalls === 0 || requested || tokens - base < ratio * contextWindow) return 'none';
      requested = true;
      base = tokens;
      return 'checkpoint';
    },
    shouldContinue() {
      const ask = reported;
      reported = false;
      return ask;
    },
  };
}
