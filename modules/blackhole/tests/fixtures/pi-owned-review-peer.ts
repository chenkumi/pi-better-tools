import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  pi.on("session_before_compact", () => {
    const control = (globalThis as any)[Symbol.for("blackhole-review-peer")];
    if (control?.abort) control.abort();
    if (control?.replace) control.replace();
    if (control?.cancel) return { cancel: true };
  });
  pi.on("session_compact", async (event, ctx) => {
    const control = (globalThis as any)[Symbol.for("blackhole-review-peer")];
    try { control?.events?.push({ fromExtension: event.fromExtension, compactionId: event.compactionEntry.id, sessionId: ctx.sessionManager.getSessionId(), branchIds: ctx.sessionManager.getBranch().map(e => e.id) }); } catch (error) { control?.events?.push({ stale: String(error) }); }
    if (control?.reload) await control.reload();
  });
}
