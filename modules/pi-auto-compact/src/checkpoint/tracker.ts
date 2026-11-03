/**
 * Pure state of the progress checkpoint. A long run of tool calls with no assistant text leaves the compactor nothing to anchor
 * on (no conversation lines, no clean cut), so once the context has grown by `ratio × contextWindow` since the last assistant
 * text the run is asked for one short report. If the run then ends right after the report, it is asked once to continue.
 * Every continuation belongs to exactly one checkpoint request, so it cannot repeat on its own and needs no cap.
 *
 * A second trigger, the deadline, serves compaction itself: shortly before Pi's compaction threshold the run is asked for a report
 * unless it already gave one inside that last stretch, so that the report written just before a compaction is the freshest one and
 * sits in the raw tail. It never fires when Pi would compact before the model
 * could answer (the request counts toward Pi's threshold check; see plan §13.8), because the answer would then see only the summary.
 */
export interface TurnFacts {
  /** Estimated context tokens after this turn, or null when unknown (right after a compaction). */
  tokens: number | null;
  contextWindow: number;
  /** The assistant message of this turn carried non-empty text. */
  hasText: boolean;
  /** The turn called the anchor tool (a progress report that is itself a tool call). */
  anchored: boolean;
  /** Tool calls of the turn other than the anchor. */
  toolCalls: number;
  /** Context tokens above which Pi compacts before its next response; absent or null when unknown or compaction is off. */
  threshold?: number | null;
}

/** How early before the threshold the deadline report is requested, as a share of the context window (plan §13.5 #1: a share of the window, not of L1). */
export const DEADLINE_MARGIN_RATIO = 0.12;
/** What the request message adds to the context Pi measures: about 100 tokens when measured, counted generously. */
export const REQUEST_TOKENS = 300;

export type TurnAction = 'none' | 'checkpoint';

export interface Tracker {
  /** A new user request starts a new count. */
  reset(): void;
  /** A compaction lowers the context; the next known size becomes the base, and an unanswered request no longer blocks the next one. */
  compacted(): void;
  turnEnd(facts: TurnFacts, ratio: number): TurnAction;
  /** The run is about to end: true when it should be asked to continue (once per report). */
  shouldContinue(): boolean;
}

export function createTracker(): Tracker {
  let base: number | null = null;
  let requested = false;
  let reported = false;
  /** Context size at the end of the turn that gave the latest report (an anchor call, or text answering a request); not reset by a user message, the context did not shrink. */
  let reportAt: number | null = null;
  const reset = () => { base = null; requested = false; reported = false; };
  return {
    reset,
    compacted() { base = null; requested = false; reportAt = null; },
    turnEnd({ tokens, contextWindow, hasText, anchored, toolCalls, threshold }, ratio) {
      if (hasText || anchored) {
        base = tokens;
        if (anchored || requested) reportAt = tokens;
        // A text-only report may end the run, so it is followed by one continuation request; an anchor call always returns to the model.
        reported = requested && !anchored && toolCalls === 0;
        requested = false;
        return 'none';
      }
      if (toolCalls > 0) reported = false;
      if (tokens === null || !(contextWindow > 0)) return 'none';
      if (toolCalls > 0 && !requested && threshold != null) {
        const zone = threshold - DEADLINE_MARGIN_RATIO * contextWindow;
        if (tokens >= zone && tokens + REQUEST_TOKENS <= threshold && (reportAt === null || reportAt < zone)) { requested = true; base = tokens; return 'checkpoint'; }
      }
      if (base === null || tokens < base) { base = tokens; return 'none'; }
      if (toolCalls === 0 || requested || tokens - base < ratio * contextWindow) return 'none';
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
