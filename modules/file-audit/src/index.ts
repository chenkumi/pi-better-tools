import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AuditTracker, ownerOf } from "./events.ts";
import { AuditCommands } from "./commands.ts";
import { changeMessage } from "./change-notice.ts";

export { ownerOf };
export default function fileAudit(pi: ExtensionAPI): void {
  const tracker = new AuditTracker();
  const commands = new AuditCommands(tracker);
  pi.registerCommand("file-audit", {
    description: "Show bounded recent file activity: /file-audit [status|clear|limits].",
    handler: (args, ctx) => commands.handle(args, ctx),
  });
  pi.on("before_agent_start", async (event, ctx) => {
    tracker.advance();
    if (event.messageType !== "user") return;
    const generation = tracker.generation;
    try {
      const [changes, git] = await Promise.all([
        tracker.changes.detect(tracker.window.snapshot().map(item => item.path), ctx.signal),
        tracker.git.detect(ctx.cwd, ctx.signal),
      ]);
      if ((changes.length || git) && generation === tracker.generation) return { message: changeMessage(changes, ctx.cwd, git) };
    } catch { /* The notice is advisory; it must never block the user's prompt. */ }
  });
  pi.on("session_start", (_event, ctx) => { tracker.reset(ownerOf(ctx)); tracker.git.mark(ctx.cwd); });
  pi.on("session_tree", (_event, ctx) => { tracker.reset(ownerOf(ctx), false); });
  pi.on("session_shutdown", () => { tracker.reset("", true, false); tracker.git.reset(); });
  pi.on("agent_settled", (_event, ctx) => { tracker.settled(); tracker.git.mark(ctx.cwd); });
  pi.on("tool_execution_start", (event, ctx) => {
    tracker.start(event.toolCallId, event.toolName, event.args, ctx.cwd, ownerOf(ctx));
  });
  pi.on("tool_execution_end", (event, ctx) => {
    tracker.finish(event.toolCallId, event.toolName, event.result, event.isError, ownerOf(ctx));
  });
}
