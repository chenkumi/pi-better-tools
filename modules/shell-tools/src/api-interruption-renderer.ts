import { Box, Container, Text, type Component } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ToolRenderers, Theme } from "@earendil-works/pi-coding-agent";
type ToolRenderContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
import { stripVTControlCharacters } from "node:util";

const LIMIT = 512;
const CARD = Symbol("api-interruption-card");
const LAST_RESULT = Symbol("api-interruption-last-result");
type Phase = "interrupted" | "resuming" | "recovered";
type RecordState = { phase: Phase; error: string };
const clean = (text: string) => stripVTControlCharacters(text.slice(0, 4096)).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ");

/** Presentation evidence only. No tools, messages, retry requests, or persisted state are changed. */
export class ApiInterruptionState {
  readonly records = new Map<string, RecordState>();
  private executed = new Set<string>();
  private pending = new Set<string>();
  private callbacks = new Map<string, () => void>();
  watch(id: string, invalidate: () => void) {
    this.callbacks.delete(id); this.callbacks.set(id, invalidate);
    if (this.callbacks.size > LIMIT) this.callbacks.delete(this.callbacks.keys().next().value!);
  }
  private notify() { for (const id of this.pending) { try { this.callbacks.get(id)?.(); } catch { /* UI cannot affect execution. */ } } }
  private add(id: string, error: string) {
    if (!id || error.length > 4096 || this.executed.has(id)) return;
    this.records.set(id, { phase: "interrupted", error }); this.pending.add(id);
    if (this.records.size > LIMIT) { const oldest = this.records.keys().next().value!; this.records.delete(oldest); this.pending.delete(oldest); }
  }
  execution(id: string) {
    this.executed.add(id); this.records.delete(id); this.pending.delete(id);
    if (this.executed.size > LIMIT) this.executed.delete(this.executed.values().next().value!);
  }
  request() { for (const id of this.pending) this.records.get(id)!.phase = "resuming"; this.notify(); }
  boundary() { for (const id of this.pending) { const r = this.records.get(id)!; if (r.phase !== "recovered") r.phase = "interrupted"; } this.notify(); this.pending.clear(); }
  message(message: any) {
    if (message?.role !== "assistant") return;
    if (message.stopReason === "error") {
      for (const id of this.pending) this.records.get(id)!.phase = "interrupted";
      for (const c of Array.isArray(message.content) ? message.content.slice(0, LIMIT) : []) {
        if (c?.type === "toolCall" && typeof c.id === "string" && c.id.length <= 512) this.add(c.id, typeof message.errorMessage === "string" ? message.errorMessage : "Error");
      }
      this.notify();
    } else if (["stop", "toolUse", "length"].includes(message.stopReason)) {
      for (const id of this.pending) { const r = this.records.get(id)!; if (r.phase === "resuming") r.phase = "recovered"; }
      this.notify(); this.pending.clear();
    } else if (message.stopReason === "aborted") this.boundary();
  }
  reset(branch: readonly any[] = []) {
    this.records.clear(); this.executed.clear(); this.pending.clear(); this.callbacks.clear();
    // Branch evidence is bounded and conservative: never infer retry success from a later unrelated response.
    const entries = branch.slice(-4096);
    const results = new Set(entries.filter(e => e.type === "message" && e.message?.role === "toolResult").map(e => e.message.toolCallId));
    for (const e of entries) if (e.type === "message" && e.message?.stopReason === "error") this.message(e.message);
    for (const id of results) this.execution(id);
    this.pending.clear();
  }
  synthetic(id: string, result: any, context: ToolRenderContext) {
    const r = this.records.get(id);
    return r && context.isError && !context.executionStarted && !context.isPartial &&
      result.details === undefined && result.structuredContent === undefined && Array.isArray(result.content) &&
      result.content.length === 1 && result.content[0]?.type === "text" && result.content[0].text === r.error ? r : undefined;
  }
}

function notice(record: RecordState, expanded: boolean, theme: Theme): Component {
  const label = record.phase === "recovered" ? "API response recovered" : record.phase === "resuming" ? "Resuming API request…" : "API interrupted · recovery not confirmed";
  const text = `${label}\nPrevious tool call was not executed.${expanded ? `\nProvider diagnostic: ${clean(record.error)}` : ""}`;
  return new Text(theme.fg("muted", text), 0, 0);
}

/** Recreates the host default Box, so synthetic errors do not leave red padding around the renderer. */
class DefaultCard implements Component {
  call?: Component;
  result?: Component;
  context!: ToolRenderContext;
  theme!: Theme;
  synthetic?: RecordState;
  invalidate() { this.call?.invalidate(); this.result?.invalidate(); }
  render(width: number) {
    const bg = this.synthetic ? "toolPendingBg" : this.context.isPartial ? "toolPendingBg" : this.context.isError ? "toolErrorBg" : "toolSuccessBg";
    const ansi = this.theme.getBgAnsi(bg);
    const box = new Box(this.context.outputPad ?? 1, 1, text => this.theme.bg(bg, text.replace(/\x1b\[(?:0)?m/g, reset => reset + ansi)));
    if (this.call) box.addChild(this.call);
    if (this.result) box.addChild(this.result);
    return box.render(width);
  }
}

export function interruptionRenderers(base: ToolRenderers, state: ApiInterruptionState): ToolRenderers {
  // Keep host fallback, undefined renderers, and third-party renderer errors unchanged.
  if (!base.renderCall || !base.renderResult) return base;
  if (base.renderShell === "self") return {
    ...base,
    renderCall(args, theme, context) {
      state.watch(context.toolCallId, context.invalidate);
      return base.renderCall!(args, theme, context);
    },
    renderResult(result, options, theme, context) {
      const record = state.synthetic(context.toolCallId, result, context);
      if (record) {
        const box = new Box(context.outputPad ?? 1, 1, text => theme.bg("toolPendingBg", text));
        box.addChild(notice(record, options.expanded, theme)); return box;
      }
      const component = base.renderResult!(result, options, theme, { ...context, lastComponent: context.state[LAST_RESULT] });
      context.state[LAST_RESULT] = component; return component;
    },
  };
  return {
    ...base, renderShell: "self",
    renderCall(args, theme, context) {
      const card: DefaultCard = context.state[CARD] ??= new DefaultCard();
      card.context = context; card.theme = theme;
      card.call = base.renderCall!(args, theme, { ...context, lastComponent: card.call });
      state.watch(context.toolCallId, context.invalidate);
      return card;
    },
    renderResult(result, options, theme, context) {
      const card: DefaultCard = context.state[CARD];
      if (!card) return base.renderResult!(result, options, theme, context);
      card.context = context; card.theme = theme;
      card.synthetic = state.synthetic(context.toolCallId, result, context);
      if (card.synthetic) card.result = notice(card.synthetic, options.expanded, theme);
      else {
        const component = base.renderResult!(result, options, theme, { ...context, lastComponent: context.state[LAST_RESULT] });
        context.state[LAST_RESULT] = component; card.result = component;
      }
      return new Container();
    },
  };
}

export function registerApiInterruptionRenderer(pi: ExtensionAPI) {
  // Some small test doubles intentionally omit the optional presentation resolver.
  if (!pi.registerToolRenderer) return;
  const state = new ApiInterruptionState();
  pi.registerToolRenderer((_name, next) => { const base = next(); return base ? interruptionRenderers(base, state) : undefined; });
  pi.on("message_end", event => { state.message(event.message); });
  pi.on("before_provider_request", () => { state.request(); });
  pi.on("tool_execution_start", event => { state.execution(event.toolCallId); });
  pi.on("tool_execution_end", event => { state.execution(event.toolCallId); });
  pi.on("input", () => { state.boundary(); });
  pi.on("agent_settled", () => { state.boundary(); });
  pi.on("session_start", (_event, ctx) => {
    state.reset();
    try {
      const branch = ctx.sessionManager?.getBranch?.();
      if (Array.isArray(branch)) state.reset(branch);
    } catch {
      // Unavailable/disposed history leaves native presentation; UI must not block session loading.
      state.reset();
    }
  });
  pi.on("session_shutdown", () => { state.reset(); });
}
