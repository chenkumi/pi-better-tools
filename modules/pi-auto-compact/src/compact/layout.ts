import type { AutoCompactConfig } from '../config.ts';

export interface Budgets { l2: number; l3: number; l4: number }

/** Budgets in characters: `max(ctx × ratio, minChars)`, where ctx is the model context window in tokens. */
export function budgetsFor(config: AutoCompactConfig, contextWindow: number): Budgets {
  const pick = (ratio: number, min: number) => Math.max(Math.floor(contextWindow * ratio), min);
  return { l2: pick(config.l2Ratio, config.l2MinChars), l3: pick(config.l3Ratio, config.l3MinChars), l4: pick(config.l4Ratio, config.l4MinChars) };
}

export interface Layout {
  /** First item of the recent-activity (L2) section; everything from here to the cut is folded activity. */
  l2Start: number;
  /** First item of the conversation (L3 plus its L4 slack) section; items before it are not shown. */
  l3Start: number;
  /** True when the recorded window start was kept (the summary beginning is unchanged), false when it was set anew. */
  keptStart: boolean;
  /** Where the window would start if it were set anew now (the nominal L3 start). */
  nominalStart: number;
}

const sum = (lens: readonly number[], from: number, to: number): number => {
  let total = 0;
  for (let i = from; i < to; i++) total += lens[i]!;
  return total;
};

/** Smallest start such that `lens[start..end)` fits in `budget`; items are never split, so a single oversized item yields `end`. */
function fitBackward(lens: readonly number[], end: number, budget: number): number {
  let start = end, used = 0;
  while (start > 0 && used + lens[start - 1]! <= budget) used += lens[--start]!;
  return start;
}

/** Skips items that show nothing in the conversation section (tool-call-only turns), so the window never starts on a blank. */
export const firstVisible = (lens3: readonly number[], from: number, end: number): number => {
  let i = from;
  while (i < end && lens3[i] === 0) i++;
  return i;
};

/**
 * Chooses the section boundaries.
 *
 * Recent activity (L2) is the newest suffix that fits its budget. The conversation section ends where L2 starts and begins at the
 * recorded window start. That start is kept while the section (L3 plus its L4 slack) fits `l3 + l4`; only when the slack is full
 * is it set to the nominal L3 start, in one step. Keeping it fixed is what leaves the summary beginning identical between
 * compactions, so the prompt cache survives. A start that is gone, or lies at or after L2, is simply set anew.
 *
 * `lens2` and `lens3` are the rendered lengths per item (0 when an item shows nothing in that section).
 */
export function chooseLayout(lens2: readonly number[], lens3: readonly number[], budgets: Budgets, previousStart: number): Layout {
  const n = lens2.length;
  const l2Start = fitBackward(lens2, n, budgets.l2);
  const nominal = firstVisible(lens3, fitBackward(lens3, l2Start, budgets.l3), l2Start);
  const keep = previousStart >= 0 && previousStart < l2Start && sum(lens3, previousStart, l2Start) <= budgets.l3 + budgets.l4;
  return { l2Start, l3Start: keep ? firstVisible(lens3, previousStart, l2Start) : nominal, keptStart: keep, nominalStart: nominal };
}
