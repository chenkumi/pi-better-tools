import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ActivityWindow, boundedString, MAX_ID_BYTES, MAX_PENDING, type FileAction } from "./activity-window.js";
import { ChangeNotice } from "./change-notice.js";
import { asRecord, canonicalPath, notePath } from "./paths.js";

/** Activity belongs to one session in one cwd; a change of either starts a new owner. */
export const ownerOf = (ctx: Pick<ExtensionContext, "sessionManager" | "cwd">): string => `${ctx.sessionManager.getSessionId()}\0${ctx.cwd}`;

interface Pending { action: FileAction; path?: string; cwd: string; owner: string; generation: number; run: number }
const ACTIONS = new Set<string>(["read", "write", "edit", "note"]);
export class AuditTracker {
  readonly window = new ActivityWindow();
  readonly changes = new ChangeNotice();
  private readonly pending = new Map<string, Pending>();
  generation = 0;
  private owner = "";
  private alive = false;
  get pendingCount(): number { return this.pending.size; }
  reset(owner: string, resetLimits = true, alive = true): void {
    this.generation++; this.owner = owner; this.alive = alive;
    this.pending.clear(); this.window.clear(resetLimits); this.changes.clear();
  }
  advance(): void { if (this.alive) this.window.advance(); }
  settled(): void { this.pending.clear(); }
  start(id: string, tool: string, args: unknown, cwd: string, owner: string): void {
    if (!this.alive || this.owner !== owner || !ACTIONS.has(tool)) return;
    if (!boundedString(id, MAX_ID_BYTES) || !boundedString(cwd) || this.pending.size >= MAX_PENDING || this.pending.has(id)) {
      this.window.skip(); return;
    }
    const path = tool === "note" ? undefined : asRecord(args).path;
    if (tool !== "note" && !boundedString(path)) { this.window.skip(); return; }
    this.pending.set(id, { action: tool as FileAction, path: path as string | undefined, cwd, owner,
      generation: this.generation, run: this.window.run });
  }
  finish(id: string, tool: string, result: unknown, isError: boolean, owner: string): void {
    const pending = this.pending.get(id);
    this.pending.delete(id);
    if (!pending || isError || !this.alive || pending.action !== tool || owner !== this.owner || pending.owner !== owner ||
        pending.generation !== this.generation || pending.run !== this.window.run) return;
    try {
      const resolved = asRecord(asRecord(result).details).path;
      const rawPath = pending.action === "note" ? notePath(result) : boundedString(resolved) ? resolved : pending.path!;
      const path = canonicalPath(rawPath, pending.cwd);
      this.window.record(path, pending.action);
      this.changes.record(path, this.window.limits.maxFiles);
    } catch { this.window.skip(); }
  }
}
