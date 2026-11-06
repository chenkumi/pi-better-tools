// Session usage totals for the footer, computed the way Pi's built-in footer does (all entries, not only post-compaction).
export interface UsageTotals { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; cacheHitRate: number | undefined }

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => typeof value === "object" && value !== null;
const num = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;

export function sumUsage(entries: readonly unknown[]): UsageTotals {
  const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, cacheHitRate: undefined };
  const add = (usage: unknown) => {
    if (!isRec(usage)) return;
    totals.input += num(usage.input); totals.output += num(usage.output);
    totals.cacheRead += num(usage.cacheRead); totals.cacheWrite += num(usage.cacheWrite);
    totals.cost += isRec(usage.cost) ? num(usage.cost.total) : 0;
  };
  for (const entry of entries) {
    if (!isRec(entry)) continue;
    const message = isRec(entry.message) ? entry.message : undefined;
    if (entry.type === "usage") add(entry.usage);
    else if (entry.type === "message" && message?.role === "assistant") {
      add(message.usage);
      const usage = isRec(message.usage) ? message.usage : {};
      const prompt = num(usage.input) + num(usage.cacheRead) + num(usage.cacheWrite);
      totals.cacheHitRate = prompt > 0 ? num(usage.cacheRead) / prompt * 100 : undefined;
    } else if (entry.type === "message" && message?.role === "toolResult") add(message.usage);
    else if (entry.type === "branch_summary" || entry.type === "compaction") add(entry.usage);
  }
  return totals;
}

/** Same compact token format as Pi's footer. */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}
