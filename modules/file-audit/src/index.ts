import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AuditTracker } from "./events.js";
import { AuditCommands } from "./commands.js";

export const ownerOf = (ctx: ExtensionContext): string => `${ctx.sessionManager.getSessionId()}\0${ctx.cwd}`;
export default function fileAudit(pi: ExtensionAPI): void {
  const tracker = new AuditTracker();
  const commands = new AuditCommands(tracker);
  pi.registerCommand("file-audit", {
    description: "Inspect bounded recent file activity; check selected provenance only on request.",
    handler: (args, ctx) => commands.handle(args, ctx),
  });
  pi.on("before_agent_start", () => { tracker.advance(); });
  pi.on("session_start", (_event, ctx) => { commands.cancel(); tracker.reset(ownerOf(ctx)); });
  pi.on("session_tree", (_event, ctx) => { commands.cancel(); tracker.reset(ownerOf(ctx), false); });
  pi.on("session_shutdown", () => { commands.cancel(); tracker.reset("", true, false); });
  pi.on("agent_settled", () => { tracker.settled(); });
  pi.on("tool_execution_start", (event, ctx) => {
    tracker.start(event.toolCallId, event.toolName, event.args, ctx.cwd, ownerOf(ctx));
  });
  pi.on("tool_execution_end", (event, ctx) => {
    tracker.finish(event.toolCallId, event.toolName, event.result, event.isError, ownerOf(ctx));
  });
}
