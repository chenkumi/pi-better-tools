/**
 * Pure state of the progress checkpoint. A long run of tool calls with no assistant text leaves the compactor nothing to anchor
 * on (no conversation lines, no clean cut), so once the context has grown by `ratio × contextWindow` since the last assistant
 * text the run is asked for one short report. If the run then ends right after the report, it is asked once to continue.
 * Every continuation belongs to exactly one checkpoint request, so it cannot repeat on its own and needs no cap.
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
}

export type TurnAction = 'none' | 'checkpoint';

export interface Tracker {
  /** A new user request starts a new count. */
  reset(): void;
  /** A compaction lowers the context; the next known size becomes the base. */
  compacted(): void;
  turnEnd(facts: TurnFacts, ratio: number): TurnAction;
  /** The run is about to end: true when it should be asked to continue (once per report). */
  shouldContinue(): boolean;
}

export function createTracker(): Tracker {
  let base: number | null = null;
  let requested = false;
  let reported = false;
  const reset = () => { base = null; requested = false; reported = false; };
  return {
    reset,
    compacted() { base = null; },
    turnEnd({ tokens, contextWindow, hasText, anchored, toolCalls }, ratio) {
      if (hasText || anchored) {
        base = tokens;
        // A text-only report may end the run, so it is followed by one continuation request; an anchor call always returns to the model.
        reported = requested && !anchored && toolCalls === 0;
        requested = false;
        return 'none';
      }
      if (toolCalls > 0) reported = false;
      if (tokens === null || !(contextWindow > 0)) return 'none';
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
