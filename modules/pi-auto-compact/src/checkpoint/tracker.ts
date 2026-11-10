import { DEFAULT_CONFIG } from '../config.ts';

/**
 * Pure state of the pre-compaction checkpoint notice (the deadline). Compaction is deterministic and calls no model, so the agent's
 * own progress can only be recorded before it happens: shortly before Pi's compaction threshold the run is told that compaction is
 * near and is guided to save a progress checkpoint (a call of the checkpoint tool, kept in the conversation). It is sent once per
 * compaction cycle, when the context size the provider reported reaches the margin before Pi's threshold, and not when that size is
 * already over the threshold (Pi compacts right after such a response, so there is nothing left to guide). It is skipped when the
 * checkpoint tool is not active, and when the turn itself already called it.
 *
 * If the first turn after the notice that calls no tool is a text answer and the run ends there, it is asked once to continue.
 */
export interface TurnFacts {
  /** Pi's context estimate after this turn (the last reported usage plus an estimate of what came after it), or null when unknown (right after a compaction). */
  tokens: number | null;
  /** Context tokens the provider reported for this turn's response; absent when it reported none (error, abort, no usage). The deadline prefers it over `tokens`. */
  reportedTokens?: number | null;
  contextWindow: number;
  /** The assistant message of this turn carried non-empty text. */
  /** The turn called the checkpoint tool. */
  checkpointed: boolean;
  /** All tool calls of the turn, the checkpoint call included. */
  toolCalls: number;
  /** Context tokens above which Pi compacts before its next response; absent or null when unknown or compaction is off. */
  threshold?: number | null;
  /** The checkpoint tool is active; the deadline is skipped without it. Absent means yes. */
  hasTool?: boolean;
  /** Floor of the deadline margin in tokens (`deadlineMarginMinTokens`); absent means the module default. */
  marginMinTokens?: number;
}

/** How early before the threshold the deadline notice is sent: a share of the context window (plan §13.5 #1: not of L1), but never less than a floor, so a small window still leaves room for a large single turn. */
export const DEADLINE_MARGIN_RATIO = 0.1;
export const deadlineMargin = (contextWindow: number, minTokens: number = DEFAULT_CONFIG.deadlineMarginMinTokens): number => Math.max(DEADLINE_MARGIN_RATIO * contextWindow, minTokens);
export type TurnAction = 'none' | 'deadline';

export interface Tracker {
  /** A new user request: an unanswered notice is closed (the deadline itself is not reset, the context did not shrink). */
  reset(): void;
  /** A session starts (new, resumed or forked): everything is forgotten, including that the deadline notice was sent. */
  restart(): void;
  /** A compaction lowers the context; the deadline may be sent again. */
  compacted(): void;
  turnEnd(facts: TurnFacts): TurnAction;
  /** The run is about to end: true when it should be asked to continue (once per notice). */
  shouldContinue(): boolean;
}

export function createTracker(): Tracker {
  let reported = false;
  /** The deadline notice was sent in this compaction cycle; not reset by a user message, the context did not shrink. */
  let deadlineSent = false;
  /** The deadline notice is not answered yet: a checkpoint call or the first later turn without tool calls answers it. */
  let deadlineOpen = false;
  const reset = () => { reported = false; deadlineOpen = false; };
  return {
    reset,
    restart() { reset(); deadlineSent = false; },
    compacted() { reported = false; deadlineSent = false; deadlineOpen = false; },
    turnEnd({ tokens, reportedTokens, contextWindow, checkpointed, toolCalls, threshold, hasTool, marginMinTokens }) {
      const answering = deadlineOpen;
      if (checkpointed || toolCalls === 0) deadlineOpen = false;
      reported = false;
      // It goes by the size the provider reported (what Pi itself compares with its threshold after a response); Pi's estimate
      // only stands in when none was reported.
      const used = reportedTokens ?? tokens;
      if (used !== null && contextWindow > 0 && toolCalls > 0 && !deadlineSent && hasTool !== false && threshold != null) {
        // The zone never starts below half of the threshold, so a small window (or a huge floor) cannot make the notice fire on the first turn.
        const zone = Math.max(threshold - deadlineMargin(contextWindow, marginMinTokens), threshold / 2);
        if (used >= zone && used < threshold) {
          deadlineSent = true;
          if (checkpointed) return 'none'; // the agent saved a checkpoint on its own in this very turn
          deadlineOpen = true;
          return 'deadline';
        }
      }
      // An answer to the notice without tool calls may end the run, so it is followed by one continuation request; a tool call always returns to the model.
      reported = answering && toolCalls === 0;
      return 'none';
    },
    shouldContinue() {
      const ask = reported;
      reported = false;
      return ask;
    },
  };
}
