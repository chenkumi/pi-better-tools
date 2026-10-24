import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { AuditTracker, ownerOf } from "./events.js";
import { validateLimits, type Limits } from "./activity-window.js";
import { resultText, safeText, statusText } from "./presentation.js";
import { failureCode, scan } from "./provenance.js";

const USAGE = "/file-audit [status|check|clear|limits --window <1–30> --max-files <1–500>]";
const MAX_ARGS_LENGTH = 1024;
const MAX_ECHO = 40;
const usageError = (problem: string) => new Error(`${problem}. Usage: ${USAGE}`);
/** A bounded, single-line echo of user input for error messages. */
const echo = (value: string) => JSON.stringify(safeText(value, MAX_ECHO));
export function parseCommand(args: string, current: Limits): { action: string; limits?: Limits } {
  if (args.length > MAX_ARGS_LENGTH) throw usageError(`Arguments exceed ${MAX_ARGS_LENGTH} characters (received ${args.length})`);
  const tokens = args.trim().split(/\s+/).filter(Boolean), action = tokens.shift() ?? "status";
  if (action !== "limits") {
    if (!["status", "check", "clear"].includes(action)) throw usageError(`Unknown action ${echo(action)} (expected one of status, check, clear, limits)`);
    if (tokens.length) throw usageError(`"${action}" takes no arguments; got ${echo(tokens[0])}`);
    return { action };
  }
  if (!tokens.length) throw usageError("limits requires at least one of --window <1–30> or --max-files <1–500>");
  const next = { ...current }, seen = new Set<string>();
  for (let i = 0; i < tokens.length; i += 2) {
    const flag = tokens[i], value = tokens[i + 1];
    if (!["--window", "--max-files"].includes(flag)) throw usageError(`Unknown flag ${echo(flag)} (expected --window or --max-files)`);
    if (seen.has(flag)) throw usageError(`${flag} was given twice`);
    if (value === undefined) throw usageError(`${flag} needs a value`);
    if (!/^\d+$/.test(value)) throw usageError(`${flag} value ${echo(value)} is not a non-negative integer`);
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
      this.cancel(); this.tracker.reset(ownerOf(ctx), false);
    } else if (command.action === "limits") {
      this.tracker.window.configure(command.limits!);
    } else if (command.action === "check") {
      if (this.active) { ctx.ui.notify("File Audit: inspection busy; no second scan queued.", "warning"); return; }
      const generation = this.tracker.generation;
      const controller = new AbortController(); this.active = controller;
      const cwd = ctx.cwd, owner = ownerOf(ctx);
      const current = () => generation === this.tracker.generation && owner === ownerOf(ctx);
      try {
        const result = await this.inspect(cwd, this.tracker.window.snapshot(), { signal: controller.signal });
        if (current() && !controller.signal.aborted) ctx.ui.notify(resultText(result, cwd), result.error ? "warning" : "info");
      } catch (error) {
        if (current() && !controller.signal.aborted) ctx.ui.notify(`File Audit: inspection failed (${failureCode(error)}); no verification claimed.`, "warning");
      } finally { if (this.active === controller) this.active = undefined; }
      return;
    }
    ctx.ui.notify(statusText(this.tracker.window, this.tracker.pendingCount, ctx.cwd), "info");
  }
}
