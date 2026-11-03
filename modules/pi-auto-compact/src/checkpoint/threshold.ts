/**
 * The compaction threshold Pi uses, resolved from `pi.getSettings()` (the effective settings: global and project merged).
 * Pi's own resolver (`SettingsManager.getCompactionSettings`) is not exposed to extensions, so this repeats its three steps and
 * is kept equal to it by `tests/threshold.test.ts`, which compares both over the same settings:
 *   `compaction.modelOverrides["<provider>/<id>"].reserveTokens` -> `compaction.reserveTokens` -> 16384.
 * Pi throws on an invalid value; here that is `undefined`, so a caller leaves the decision to Pi instead of guessing.
 * Not used by any hook yet: it backs the planned pre-compaction savepoint (plan/pi-auto-compact-plan.md §13).
 */
export const DEFAULT_RESERVE_TOKENS = 16384;

export interface CompactionBudget {
  /** Pi compacts only when this is true; it is a truthiness test there, so any non-nullish falsy value disables it. */
  enabled: boolean;
  reserveTokens: number;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
/** Same as `value?.[key]` in Pi, including for values that are not objects. */
const prop = (value: unknown, key: string): unknown => value === null || value === undefined ? undefined : (value as Record<string, unknown>)[key];
const valid = (value: unknown): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function resolveCompactionBudget(settings: unknown, model: { provider: string; id: string } | undefined): CompactionBudget | undefined {
  const compaction = prop(settings, 'compaction');
  const ordinary = prop(compaction, 'reserveTokens');
  if (ordinary !== undefined && !valid(ordinary)) return undefined;
  const entry = model === undefined ? undefined : prop(prop(compaction, 'modelOverrides'), `${model.provider}/${model.id}`);
  if (entry !== undefined && !isObject(entry)) return undefined;
  const override = prop(entry, 'reserveTokens');
  if (override !== undefined && !valid(override)) return undefined;
  const reserveTokens = (override ?? ordinary ?? DEFAULT_RESERVE_TOKENS) as number;
  return { enabled: Boolean(prop(compaction, 'enabled') ?? true), reserveTokens };
}

/** Context tokens above which Pi compacts before its next response, or `undefined` when it cannot be known. */
export function compactionThreshold(settings: unknown, model: { provider: string; id: string; contextWindow?: number } | undefined): number | undefined {
  const window = model?.contextWindow;
  if (typeof window !== 'number' || !(window > 0)) return undefined;
  const budget = resolveCompactionBudget(settings, model);
  return budget?.enabled ? window - budget.reserveTokens : undefined;
}
