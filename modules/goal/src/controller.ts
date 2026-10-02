import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext, AgentBeforeSettleEvent, MessageEndEvent,
  InputEvent, ToolCallEvent, ToolExecutionStartEvent, ToolExecutionEndEvent } from "@earendil-works/pi-coding-agent";
import { STATE_TYPE, CONTROL_TYPE, MAX_AUTO_REQUESTS, MAX_EMPTY_RESPONSES, validateArguments, validateSnapshot,
  latestSnapshot, newGoal, resumeGoal, parseCommand, type GoalState, type GoalArguments } from "./state.ts";
import { controlEntry, filterControls, launchPrompt, launchIdentity } from "./prompts.ts";

// appendCustomEntry mutates Pi's manager before disk I/O. A failed tentative outcome
// must not become authoritative on reload. Symbol.for survives TS loader reloads.
interface ManagerSafety { epoch: number; fault?: string }
const safetyKey = Symbol.for("pi-better-tools.goal.manager-safety.v1");
const globals = globalThis as typeof globalThis & { [safetyKey]?: WeakMap<object, ManagerSafety> };
const safety = globals[safetyKey] ??= new WeakMap<object, ManagerSafety>();
interface Ownership { goalId: string; runId: string; phase: "pending" | "preparing" | "ready" | "running"; activity: boolean; automatic: boolean; stopped: boolean }

export class GoalController {
  private manager?: ExtensionContext["sessionManager"];
  private sessionId?: string;
  private latch?: ManagerSafety;
  private epoch = 0;
  private retired = false;
  private goal: GoalState | null = null;
  private diagnostic?: string;
  private owner?: Ownership;
  private inFlight = new Set<string>();
  private boundaries = new WeakSet<object>();
  private revision = 0;

  constructor(private readonly pi: ExtensionAPI) {}

  restore(ctx: ExtensionContext) {
    this.manager = ctx.sessionManager;
    this.sessionId = ctx.sessionManager.getSessionId();
    this.latch = safety.get(this.manager) ?? { epoch: 0 };
    safety.set(this.manager, this.latch);
    this.epoch = ++this.latch.epoch;
    this.retired = false;
    this.owner = undefined;
    this.inFlight.clear();
    this.boundaries = new WeakSet();
    this.revision++;
    this.goal = null;
    this.diagnostic = this.latch.fault;
    if (!this.diagnostic) {
      try {
        this.goal = latestSnapshot(ctx.sessionManager.getBranch());
        if (this.goal && resolve(this.goal.cwd) !== resolve(ctx.cwd)) {
          this.diagnostic = "GOAL_WORKSPACE_MISMATCH: Goal belongs to another workspace; clear it before starting a new goal.";
          if (this.goal.status === "active") this.goal = { ...this.goal, status: "paused", stopReason: this.diagnostic };
        } else if (this.goal?.status === "active") {
          this.save({ ...this.goal, status: "paused", stopReason: "Session restored or branch changed; use /goal resume.", updatedAt: new Date().toISOString() }, ctx);
        }
      } catch (error) { this.diagnostic = String(error); }
    }
    this.render(ctx);
  }

  private current(ctx: ExtensionContext): boolean {
    try { return !this.retired && this.manager === ctx.sessionManager && this.sessionId === ctx.sessionManager.getSessionId() && this.epoch === this.latch?.epoch; }
    catch { return false; } // retired Pi contexts throw rather than exposing a new session
  }
  private writable(ctx: ExtensionContext, clearing = false) {
    if (!this.current(ctx)) throw new Error("GOAL_STALE_SESSION: Session or extension runtime changed.");
    if (this.latch?.fault) throw new Error(this.latch.fault);
    if (this.diagnostic && !clearing) throw new Error(this.diagnostic);
  }
  private owned(ctx: ExtensionContext): boolean {
    return this.current(ctx) && !!this.owner && !!this.goal && this.owner.goalId === this.goal.id && this.owner.runId === this.goal.runId;
  }
  private save(goal: GoalState | null, ctx: ExtensionContext) {
    this.writable(ctx, goal === null);
    const snapshot = validateSnapshot({ version: 1, goal });
    try { this.pi.appendEntry(STATE_TYPE, snapshot); }
    catch (error) {
      const fault = `GOAL_STORAGE_FAULT: ${String(error)}. Goal execution disabled; repair storage and reopen the session from disk (reload alone is insufficient).`;
      this.latch!.fault = fault;
      this.diagnostic = fault;
      if (this.owner) this.owner.stopped = true;
      this.render(ctx);
      throw new Error(fault, { cause: error });
    }
    // Don't retain Pi's mutable snapshot object as extension authority.
    this.goal = structuredClone(snapshot.goal);
    this.diagnostic = undefined;
    this.revision++;
    this.render(ctx);
  }
  private stop(reason: string, ctx: ExtensionContext, abort = false) {
    if (!this.current(ctx)) return;
    if (this.owner) this.owner.stopped = true; // fence before save or host abort
    try {
      if (this.goal?.status === "active" && !this.latch?.fault) {
        this.save({ ...this.goal, status: "paused", stopReason: reason, updatedAt: new Date().toISOString() }, ctx);
        this.notice(reason, ctx, "warning");
      }
    } finally { if (abort) ctx.abort(); }
  }
  private startable(ctx: ExtensionContext) {
    this.writable(ctx);
    if (!ctx.isIdle() || ctx.hasPendingMessages() || this.owner) throw new Error("GOAL_BUSY: Start/replace/resume requires idle, no pending messages and no owned launch. Pause the current goal first.");
    if (!this.pi.getActiveTools().includes("goal")) throw new Error("GOAL_TOOL_DISABLED: The goal tool must be selected; this extension will not enable excluded tools.");
  }
  private launch(goal: GoalState, ctx: ExtensionContext) {
    this.save(goal, ctx);
    this.owner = { goalId: goal.id, runId: goal.runId, phase: "pending", activity: false, automatic: false, stopped: false };
    this.render(ctx);
    try { this.pi.sendUserMessage(launchPrompt(goal), { expandPromptTemplates: false }); }
    catch (error) { this.stop(`Goal launch failed: ${String(error)}`, ctx); this.owner = undefined; throw error; }
    // This void API is not an acknowledgement. No timers, retries or model calls
    // are started here. Only admitted agent events may propose continuations.
  }

  async command(args: string, ctx: ExtensionCommandContext) {
    const command = parseCommand(args);
    if (command.action === "status" || command.action === "show") {
      if (this.goal || this.diagnostic || command.action === "status" || !ctx.hasUI) { this.show(ctx); return; }
      this.startable(ctx);
      const revision = this.revision, epoch = this.epoch;
      const objective = await ctx.ui.input("Goal 驗收目標", "完整成果條件與限制（最多 4,000 字元）");
      if (objective === undefined) return;
      if (epoch !== this.epoch || revision !== this.revision || !this.current(ctx)) throw new Error("GOAL_STALE_DIALOG: Goal/session changed while entering objective.");
      this.startable(ctx);
      this.launch(newGoal(objective, resolve(ctx.cwd)), ctx);
      return;
    }
    if (command.action === "pause") {
      // Cancellation must remain available even when saving is impossible.
      if (!this.current(ctx)) throw new Error("GOAL_STALE_SESSION");
      const hadLaunch = !!this.owner;
      this.stop("Paused by user; cancellation requested (existing side effects are not rolled back).", ctx, hadLaunch);
      if (ctx.isIdle()) this.owner = undefined;
      this.render(ctx); return;
    }
    if (command.action === "clear") {
      this.writable(ctx, true);
      const hadLaunch = !!this.owner;
      if (this.owner) this.owner.stopped = true;
      try { this.save(null, ctx); }
      finally { if (hadLaunch) ctx.abort(); }
      if (ctx.isIdle()) this.owner = undefined;
      this.notice("Goal cleared; existing project changes are not undone.", ctx); return;
    }
    this.startable(ctx);
    if (command.action === "resume") {
      if (!this.goal) throw new Error("GOAL_NOT_FOUND: Create an acceptance goal first.");
      this.launch(resumeGoal(this.goal), ctx); return;
    }
    if (this.goal && this.goal.status !== "complete") {
      if (!ctx.hasUI) throw new Error("GOAL_REPLACE_CONFIRMATION: Use /goal clear before replacing an unfinished goal in headless mode.");
      const revision = this.revision, epoch = this.epoch;
      const confirmed = await ctx.ui.confirm("取代目前 Goal？", "未完成的驗收目標會被取代；既有修改不會撤銷。");
      if (!confirmed) return;
      if (epoch !== this.epoch || revision !== this.revision || !this.current(ctx)) throw new Error("GOAL_STALE_DIALOG: Goal/session changed while confirming replacement.");
      this.startable(ctx);
    }
    this.launch(newGoal(command.objective, resolve(ctx.cwd)), ctx);
  }

  input(event: InputEvent, ctx: ExtensionContext) {
    const identity = launchIdentity(event.text);
    const authorized = this.owned(ctx) && !this.owner!.stopped && this.goal?.status === "active" &&
      identity?.goalId === this.owner!.goalId && identity.runId === this.owner!.runId;
    if (identity && !authorized) return { action: "handled" as const }; // late/cancelled launch, including after reload
    if (!this.owned(ctx) || this.owner!.phase === "running") return;
    if (event.source === "extension" && authorized) this.owner!.phase = "preparing";
    else {
      const corruptedLaunch = event.source === "extension" && this.owner!.phase === "pending";
      this.stop("Launch input was replaced or superseded; use /goal resume.", ctx);
      this.owner = undefined;
      if (corruptedLaunch) return { action: "handled" as const };
    }
  }
  beforeStart(prompt: string, ctx: ExtensionContext) {
    const identity = launchIdentity(prompt);
    const authorized = this.owned(ctx) && !this.owner!.stopped && this.goal?.status === "active" && !this.latch?.fault &&
      this.pi.getActiveTools().includes("goal") && identity?.goalId === this.owner!.goalId && identity.runId === this.owner!.runId;
    if (identity && !authorized || !identity && this.owned(ctx) && this.owner!.phase === "preparing") {
      const details = identity ?? { goalId: this.owner!.goalId, runId: this.owner!.runId };
      if (this.owned(ctx) && (!identity || identity.goalId === this.owner!.goalId && identity.runId === this.owner!.runId)) {
        this.stop("Launch authorization or correlation marker changed; explicit resume required.", ctx);
      }
      // before_agent_start cannot cancel Pi's preflight. Always leave a fence
      // for message_start, even if pause/clear removed the owner or reload retired it.
      return { message: { customType: CONTROL_TYPE, display: false, content: "This goal launch is cancelled. Do not execute it.", details: { ...details, cancelled: true } } };
    }
    if (!this.owned(ctx) || this.owner!.stopped || this.goal!.status !== "active" || this.latch?.fault) return;
    if (!this.pi.getActiveTools().includes("goal")) { this.stop("Goal tool no longer selected; use /goal resume after enabling it.", ctx); return; }
    if (this.owner!.phase === "preparing" && authorized) this.owner!.phase = "ready";
    else if (this.owner!.phase !== "running") return;
    const { type: _type, ...message } = controlEntry(this.goal!);
    return { message }; // don't overwrite the host's system prompt or any prompt sections
  }
  agentStarted(ctx: ExtensionContext) {
    if (!this.owned(ctx)) return;
    const owner = this.owner!;
    if (owner.stopped) { ctx.abort(); return; }
    // agent_start contains no prompt/run identity. A delayed cancelled launch
    // must not promote a newer ready owner. Initial admission occurs only when
    // its matching control message is emitted; existing continuation stays owned.
    if (owner.phase === "running") owner.activity = false;
    this.render(ctx);
  }
  messageStarted(message: MessageEndEvent["message"], ctx: ExtensionContext) {
    // A preflight may finish after pause/clear/reload. Its unique control entry
    // is emitted before the first provider request; cancel this orphan launch.
    if (message.role === "custom" && message.customType === CONTROL_TYPE) {
      const details = message.details as { goalId?: string; runId?: string; cancelled?: boolean } | undefined;
      if (details?.cancelled || !this.owned(ctx) || this.owner!.stopped || this.goal?.status !== "active" ||
        details?.goalId !== this.goal.id || details.runId !== this.goal.runId) {
        ctx.abort();
      } else if (this.owner!.phase === "ready") {
        this.owner!.phase = "running";
        this.owner!.activity = false;
        this.render(ctx);
      }
    }
  }
  messageEnded(event: MessageEndEvent, ctx: ExtensionContext) {
    if (!this.owned(ctx) || this.owner!.phase !== "running") return;
    const m = event.message;
    if (m.role === "assistant") {
      if (m.stopReason === "error" || m.stopReason === "aborted") { this.stop(`Agent ${m.stopReason}; automatic goal work paused.`, ctx); return; }
      if (m.content.some(c => c.type === "toolCall" || c.type === "text" && !!c.text.trim())) this.owner!.activity = true;
    } else if (m.role === "toolResult") this.owner!.activity = true;
  }
  toolStarted(event: ToolExecutionStartEvent, ctx: ExtensionContext) {
    if (this.owned(ctx) && this.owner!.phase === "running" && event.toolName !== "goal") this.inFlight.add(event.toolCallId);
  }
  toolEnded(event: ToolExecutionEndEvent, ctx: ExtensionContext) {
    if (this.owned(ctx)) { this.inFlight.delete(event.toolCallId); this.owner!.activity = true; }
  }
  toolCall(event: ToolCallEvent, ctx: ExtensionContext) {
    if (!this.current(ctx) || !this.owner || this.owner.phase !== "running") return;
    if (event.toolName === "goal") return; // execute still checks ownership, run IDs and signal
    if (this.owner.stopped || !this.goal || this.goal.status !== "active" || this.latch?.fault) {
      return { block: true, reason: "GOAL_STOPPED: Working tools are disabled for this stopped goal operation; provide a final summary.", terminate: true };
    }
  }
  execute(args: GoalArguments, ctx: ExtensionContext, signal?: AbortSignal) {
    validateArguments(args);
    if (args.action === "get") {
      if (!this.current(ctx)) throw new Error("GOAL_STALE_SESSION");
      return { goal: this.latch?.fault ? null : structuredClone(this.goal), diagnostic: this.diagnostic ?? null };
    }
    this.writable(ctx);
    signal?.throwIfAborted();
    ctx.signal?.throwIfAborted();
    if (!this.owned(ctx) || this.owner!.phase !== "running" || !this.goal || args.goalId !== this.goal.id || args.runId !== this.goal.runId) throw new Error("GOAL_STALE_RUN: Outcome does not belong to the running goal operation.");
    const goal = this.goal;
    // Retry is idempotent only for the exact committed outcome in this operation.
    if (args.action === "complete" && goal.status === "complete" && goal.resultSummary === args.summary && JSON.stringify(goal.verification) === JSON.stringify(args.verification) ||
      args.action === "blocked" && goal.status === "blocked" && goal.stopReason === args.reason && goal.suggestedAction === args.suggestedAction) return { goal: structuredClone(goal), diagnostic: null };
    if (goal.status !== "active" || this.owner!.stopped) throw new Error("GOAL_NOT_ACTIVE: A paused/stopped goal cannot accept an outcome.");
    if (this.inFlight.size) throw new Error("GOAL_WORK_IN_FLIGHT: Wait for working tools to finish and re-verify before submitting an outcome.");
    const outcome: GoalState = args.action === "complete"
      ? { ...goal, status: "complete", resultSummary: args.summary, verification: structuredClone(args.verification), updatedAt: new Date().toISOString() }
      : { ...goal, status: "blocked", stopReason: args.reason, suggestedAction: args.suggestedAction, updatedAt: new Date().toISOString() };
    this.save(outcome, ctx);
    this.owner!.stopped = true;
    this.notice(args.action === "complete" ? "Goal complete：驗收報告已保存（模型提供的證據，非獨立審核）。" : `Goal blocked：${args.reason}\n${args.suggestedAction}`, ctx);
    return { goal: structuredClone(this.goal), diagnostic: null };
  }

  beforeSettle(event: AgentBeforeSettleEvent, ctx: ExtensionContext) {
    if (!this.owned(ctx) || this.owner!.phase !== "running" || this.owner!.stopped || this.goal!.status !== "active" || this.latch?.fault) return;
    if (event.outcome !== "completed" || ctx.signal?.aborted) { this.stop(`Agent ${event.outcome}; goal paused.`, ctx); return; }
    if (!this.pi.getActiveTools().includes("goal")) { this.stop("Goal tool no longer selected; explicit resume required.", ctx); return; }
    if (event.continue || event.context.pendingMessages.length || ctx.hasPendingMessages()) return;
    if (this.boundaries.has(event)) return;
    this.boundaries.add(event);
    const owner = this.owner!, goal = this.goal!;
    const emptyResponses = owner.automatic && !owner.activity ? goal.emptyResponses + 1 : 0;
    if (emptyResponses >= MAX_EMPTY_RESPONSES) {
      this.save({ ...goal, emptyResponses: MAX_EMPTY_RESPONSES, updatedAt: new Date().toISOString() }, ctx);
      this.stop("Three consecutive empty automatic responses; use /goal resume after investigating.", ctx); return;
    }
    if (goal.autoRequests >= MAX_AUTO_REQUESTS) { this.stop("Goal reached 20 own continuation proposals; use /goal resume to authorize more work.", ctx); return; }
    this.save({ ...goal, autoRequests: goal.autoRequests + 1, emptyResponses, updatedAt: new Date().toISOString() }, ctx);
    owner.automatic = true;
    owner.activity = false;
    return { entries: [...event.entries, controlEntry(this.goal!)], continue: true };
  }
  settled(ctx: ExtensionContext) {
    if (!this.current(ctx)) return;
    // A cancelled orphan may settle while a newer launch is still in preflight;
    // and host overlap can report settlement while its real stream is still live.
    if (this.owner && this.owner.phase !== "running" || ctx.signal && !ctx.signal.aborted) return;
    // A downstream boundary veto, abort or host failure may bypass continuation.
    // Do not leave active ownership ready to hijack an unrelated future prompt.
    try { if (this.owner && this.goal?.status === "active") this.stop("Goal operation settled without completion; use /goal resume.", ctx); }
    finally { this.owner = undefined; this.inFlight.clear(); this.render(ctx); }
  }
  context(messages: MessageEndEvent["message"][], ctx: ExtensionContext) {
    return { messages: filterControls(messages, this.owned(ctx) && !this.owner!.stopped && !this.latch?.fault ? this.goal : null) };
  }
  shutdown(ctx: ExtensionContext) {
    this.retired = true;
    this.owner = undefined;
    this.inFlight.clear();
    if (ctx.hasUI) ctx.ui.setStatus("goal", undefined);
    // No append: this may be the old runtime during a session replacement.
  }
  private render(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    const label = this.diagnostic ? "Goal: disabled (storage/state error)" : !this.goal ? undefined
      : `Goal: ${this.goal.objective.replace(/[\r\n\t\x00-\x1f\x7f]/g, " ").slice(0, 80)} [${this.goal.status}${this.owner && this.owner.phase !== "running" ? "/pending" : ""}] · Auto ${this.goal.autoRequests}/${MAX_AUTO_REQUESTS}`;
    ctx.ui.setStatus("goal", label);
  }
  private notice(text: string, ctx: ExtensionContext, type: "info" | "warning" = "info") {
    if (ctx.hasUI) ctx.ui.notify(text, type);
    else this.pi.sendMessage({ customType: "pi-better-goal-notice", content: text, display: true }, { triggerTurn: false });
  }
  private show(ctx: ExtensionContext) {
    const text = JSON.stringify({ goal: this.latch?.fault ? null : this.goal, diagnostic: this.diagnostic ?? null,
      execution: this.owner?.phase ?? "idle", usage: "/goal <目標> | status | pause | resume | clear; /goal -- <同名目標>" }, null, 2);
    this.notice(text, ctx);
  }
}
