import { AssistantMessageComponent, ToolExecutionComponent, UserMessageComponent, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";

/**
 * Untrusted command output for a multi-line view: keeps newlines, but nothing that can move the cursor, overwrite earlier
 * rows or reorder text (CR, BEL, backspace, C0/C1 controls, bidi overrides/isolates).
 */
export function safeOutputText(text: string): string {
  return stripVTControlCharacters(text)
    .replace(/\r\n?/g, "\n").replace(/\t/g, "  ")
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}

type Rec = Record<string, any>;
interface ToolState { started: boolean; partial?: Rec; result?: Rec }
type Item = { kind: "user"; text: string } | { kind: "assistant"; message: Rec; streaming: boolean };
/** Lines of a tool result shown while the live view is collapsed; Ctrl+O renders the whole result. */
const COLLAPSED_RESULT_LINES = 10;
const isRec = (value: unknown): value is Rec => !!value && typeof value === "object" && !Array.isArray(value);
/** Presentation-only trimming of a result the copy already holds in full; expanding re-renders from the source. */
function boundedResult(result: Rec, expanded: boolean): Rec {
  if (expanded) return result;
  const content = Array.isArray(result.content) ? result.content : [];
  let budget = COLLAPSED_RESULT_LINES;
  const clipped = content.map((part: unknown) => {
    if (!isRec(part) || part.type !== "text" || typeof part.text !== "string") return part;
    const lines = part.text.split("\n");
    if (lines.length <= budget) { budget -= lines.length; return part; }
    const kept = lines.slice(0, Math.max(1, budget));
    budget = 0;
    return { ...part, text: `${kept.join("\n")}\n… (${lines.length - kept.length} more lines, Ctrl+O to expand)` };
  });
  return { ...result, content: clipped };
}
const textOf = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map(part => isRec(part) && part.type === "text" && typeof part.text === "string" ? part.text : "").join("") : "";

/**
 * In-memory copy of one child's conversation, built from the same RPC events the parent already receives.
 * Presentation only: never a record, never fed to a model. `release()` at the terminal state drops everything,
 * so the copy lives exactly as long as the task runs.
 */
export class LiveTranscript {
  readonly mode = "conversation" as const;
  private items: Item[] = [];
  private tools = new Map<string, ToolState>();
  private listeners = new Set<() => void>();
  private released = false;
  version = 0;

  subscribe(listener: () => void): () => void {
    if (this.released) return () => {};
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  get isReleased() { return this.released; }
  snapshot(): { items: readonly Item[]; tools: ReadonlyMap<string, ToolState> } { return { items: this.items, tools: this.tools }; }
  release() {
    if (this.released) return;
    this.released = true; this.items = []; this.tools = new Map(); this.version++;
    const listeners = [...this.listeners]; this.listeners.clear();
    for (const listener of listeners) try { listener(); } catch { /* observer failures never reach the child */ }
  }
  /** Mirrors the main TUI's event switch, minus anything that needs the host session. */
  ingest(event: unknown) {
    if (this.released || !isRec(event)) return;
    const message = isRec(event.message) ? event.message : undefined;
    let changed = true;
    switch (event.type) {
      case "message_start":
        if (message?.role === "user") this.items.push({ kind: "user", text: textOf(message.content) });
        else if (message?.role === "assistant") this.items.push({ kind: "assistant", message, streaming: true });
        else changed = false;
        break;
      case "message_update":
      case "message_end": {
        if (message?.role === "toolResult") {
          const id = String(message.toolCallId ?? "");
          const state = this.tool(id);
          if (!state.result) state.result = { content: message.content, details: message.details, isError: message.isError === true };
          break;
        }
        if (message?.role !== "assistant") { changed = false; break; }
        const last = this.items[this.items.length - 1];
        const streaming = event.type === "message_update";
        if (last?.kind === "assistant" && last.streaming) { last.message = message; last.streaming = streaming; }
        else this.items.push({ kind: "assistant", message, streaming });
        break;
      }
      case "tool_execution_start": this.tool(String(event.toolCallId)).started = true; break;
      case "tool_execution_update": if (isRec(event.partialResult)) this.tool(String(event.toolCallId)).partial = { ...event.partialResult, isError: false }; break;
      case "tool_execution_end": {
        const state = this.tool(String(event.toolCallId));
        state.partial = undefined;
        state.result = { ...(isRec(event.result) ? event.result : { content: [{ type: "text", text: String(event.result ?? "") }] }), isError: event.isError === true, durationMs: event.durationMs };
        break;
      }
      default: changed = false;
    }
    if (!changed) return;
    this.version++;
    for (const listener of [...this.listeners]) try { listener(); } catch { /* ignored */ }
  }
  private tool(id: string): ToolState {
    let state = this.tools.get(id);
    if (!state) { state = { started: false }; this.tools.set(id, state); }
    return state;
  }
}

/** Bytes retained per shell job output copy: a noisy command cannot grow its memory copy past this bound. */
export const OUTPUT_TRANSCRIPT_BYTES = 128 * 1024;

/**
 * In-memory copy of one shell job's output tail, fed from the chunks the job already receives.
 * Presentation only: nothing is written, parsed for state or sent to a model, and `release()`
 * drops the bytes when the job reaches a terminal state.
 */
export class OutputTranscript {
  readonly mode = "output" as const;
  private buffer = Buffer.alloc(0);
  private dropped = 0;
  private listeners = new Set<() => void>();
  private released = false;
  version = 0;
  constructor(private limit = OUTPUT_TRANSCRIPT_BYTES) {}
  subscribe(listener: () => void): () => void {
    if (this.released) return () => {};
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  get isReleased() { return this.released; }
  release() {
    if (this.released) return;
    this.released = true; this.buffer = Buffer.alloc(0); this.version++;
    const listeners = [...this.listeners]; this.listeners.clear();
    for (const listener of listeners) try { listener(); } catch { /* observer failures never reach the job */ }
  }
  /** Only the last `limit` bytes are kept; evicted bytes are counted, never retained. */
  append(chunk: Buffer) {
    if (this.released || !chunk.length) return;
    const data = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    if (data.length > this.limit) { this.dropped += data.length - this.limit; this.buffer = Buffer.from(data.subarray(data.length - this.limit)); }
    else this.buffer = data;
    this.version++;
    for (const listener of [...this.listeners]) try { listener(); } catch { /* ignored */ }
  }
  snapshot(): { text: string; truncated: boolean } { return { text: this.buffer.toString("utf8"), truncated: this.dropped > 0 }; }
}

/** Anything the jobs overlay can show as live detail for a running job. */
export type TranscriptSource = LiveTranscript | OutputTranscript;

/** Renders a live copy with the host's own message components so it matches the main conversation view. */
export class TranscriptView extends Container {
  private builtVersion = -1;
  private builtExpanded = false;
  constructor(private source: TranscriptSource, private tui: TUI, private cwd: string, private expanded = false) { super(); }
  setExpanded(expanded: boolean) { this.expanded = expanded; }
  private rebuild() {
    this.clear();
    if (this.source.mode === "output") {
      const { text, truncated } = this.source.snapshot();
      const body = safeOutputText(text);
      this.addChild(new Text(`${truncated ? "… earlier output omitted (bounded memory copy)\n" : ""}${body || "(no output observed yet)"}`, 0, 0));
      this.builtVersion = this.source.version; this.builtExpanded = this.expanded;
      return;
    }
    const { items, tools } = this.source.snapshot();
    const markdown = getMarkdownTheme();
    for (const item of items) {
      if (item.kind === "user") { this.addChild(new UserMessageComponent(item.text, markdown)); continue; }
      this.addChild(new AssistantMessageComponent(item.message as any, false, markdown));
      const content = Array.isArray(item.message.content) ? item.message.content : [];
      for (const part of content) {
        if (!isRec(part) || part.type !== "toolCall") continue;
        const state = tools.get(String(part.id));
        const tool = new ToolExecutionComponent(String(part.name), String(part.id), part.arguments, {}, undefined, this.tui, this.cwd);
        tool.setExpanded(this.expanded);
        if (state?.started) tool.markExecutionStarted();
        if (!item.streaming) tool.setArgsComplete();
        if (state?.result) tool.updateResult(boundedResult(state.result, this.expanded) as any);
        else if (state?.partial) tool.updateResult(boundedResult(state.partial, this.expanded) as any, true);
        this.addChild(tool);
      }
    }
    if (!items.length) this.addChild(new Spacer(0));
    this.builtVersion = this.source.version; this.builtExpanded = this.expanded;
  }
  render(width: number): string[] {
    if (this.builtVersion !== this.source.version || this.builtExpanded !== this.expanded) this.rebuild();
    return super.render(width);
  }
}
