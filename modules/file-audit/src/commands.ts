import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { AuditTracker } from "./events.js";
import { validateLimits, type Limits } from "./activity-window.js";
import { resultText, safeText, statusText } from "./presentation.js";
import { scan } from "./provenance.js";

const USAGE = "/file-audit [status|check|clear|limits --window <1–30> --max-files <1–500>]";
export function parseCommand(args: string, current: Limits): { action: string; limits?: Limits } {
  if (args.length > 1024) throw new Error(USAGE);
  const tokens = args.trim().split(/\s+/).filter(Boolean), action = tokens.shift() ?? "status";
  if (action !== "limits") {
    if (!["status", "check", "clear"].includes(action) || tokens.length) throw new Error(USAGE);
    return { action };
  }
  if (!tokens.length || tokens.length % 2) throw new Error(USAGE);
  const next = { ...current }, seen = new Set<string>();
  for (let i = 0; i < tokens.length; i += 2) {
    const flag = tokens[i], value = tokens[i + 1];
    if (seen.has(flag) || !["--window", "--max-files"].includes(flag) || !/^\d+$/.test(value)) throw new Error(USAGE);
    seen.add(flag);
    next[flag === "--window" ? "windowRuns" : "maxFiles"] = Number(value);
  }
  validateLimits(next);
  return { action, limits: next };
}
export class AuditCommands {
  private active?: AbortController;
  constructor(readonly tracker: AuditTracker, private readonly inspect: typeof scan = scan) {}
  cancel(): void { this.active?.abort(); }
  async handle(args: string, ctx: ExtensionCommandContext): Promise<void> {
    if (ctx.mode !== "tui") return;
    let command: ReturnType<typeof parseCommand>;
    try { command = parseCommand(args, this.tracker.window.limits); }
    catch (error) { ctx.ui.notify(safeText(error instanceof Error ? error.message : USAGE, 500), "warning"); return; }
    if (command.action === "clear") {
      this.cancel(); this.tracker.reset(`${ctx.sessionManager.getSessionId()}\0${ctx.cwd}`, false);
    } else if (command.action === "limits") {
      this.tracker.window.configure(command.limits!);
    } else if (command.action === "check") {
      if (this.active) { ctx.ui.notify("File Audit: inspection busy; no second scan queued.", "warning"); return; }
      const generation = this.tracker.generation;
      const controller = new AbortController(); this.active = controller;
      const cwd = ctx.cwd, owner = `${ctx.sessionManager.getSessionId()}\0${cwd}`;
      const current = () => generation === this.tracker.generation && owner === `${ctx.sessionManager.getSessionId()}\0${ctx.cwd}`;
      try {
        const result = await this.inspect(cwd, this.tracker.window.snapshot(), { signal: controller.signal });
        if (current() && !controller.signal.aborted) ctx.ui.notify(resultText(result, cwd), result.error ? "warning" : "info");
      } catch {
        if (current() && !controller.signal.aborted) ctx.ui.notify("File Audit: inspection failed; no verification claimed.", "warning");
      } finally { if (this.active === controller) this.active = undefined; }
      return;
    }
    ctx.ui.notify(statusText(this.tracker.window, this.tracker.pendingCount, ctx.cwd), "info");
  }
}
