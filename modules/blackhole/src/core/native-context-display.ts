/** Public context usage is capacity/measurement, not Pi's effective trigger budget.
 * The public extension context does not expose reserveTokens/keepRecentTokens.
 * Never guess them from Blackhole presets, defaults, or a selected model.
 */
export function nativeContextDisplay(ctx: { getContextUsage?: () => unknown } | undefined): string {
  try {
    const usage = ctx?.getContextUsage?.() as { tokens?: unknown; contextWindow?: unknown } | undefined;
    if (typeof usage?.tokens === "number" && Number.isFinite(usage.tokens) && usage.tokens >= 0 && typeof usage.contextWindow === "number" && Number.isFinite(usage.contextWindow) && usage.contextWindow > 0) {
      return `Pi-owned · context ${Math.round(usage.tokens).toLocaleString()}/${Math.round(usage.contextWindow).toLocaleString()} tokens (capacity) · native trigger budget unknown`;
    }
  } catch { /* A stale/failed public lookup cannot manufacture an effective budget. */ }
  return "Pi-owned · context usage unknown · native trigger budget unknown";
}
