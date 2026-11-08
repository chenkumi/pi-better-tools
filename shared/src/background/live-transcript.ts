import { AssistantMessageComponent, ToolExecutionComponent, UserMessageComponent, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
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

/** A content block index from an untrusted child event: an existing block or the next one, never a sparse jump. */
const MAX_BLOCKS = 4096;
const blockIndex = (value: unknown, length: number): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= length && value < MAX_BLOCKS ? value : undefined;

/**
 * Folds one wire-format content-block update into `content` (replacing blocks, never mutating them).
 * Pi's RPC `message_update` is delta-only: it carries `assistantMessageEvent` and no cumulative `message` or `partial`.
 * `*_end` replaces what the deltas built; `message_end` later replaces the whole message.
 * Tool-call start/delta have no id or name on the wire, so only `toolcall_end` (the complete call) is shown.
 * Returns false for events that change nothing here.
 */
function foldBlockEvent(content: Rec[], update: Rec): boolean {
  const type = typeof update.type === "string" ? update.type : "";
  const kind = type.startsWith("text_") ? "text" : type.startsWith("thinking_") ? "thinking" : type === "toolcall_end" ? "toolCall" : undefined;
  if (!kind) return false;
  const index = blockIndex(update.contentIndex, content.length);
  if (index === undefined) return false;
  if (kind === "toolCall") {
    if (!isRec(update.toolCall)) return false;
    content[index] = update.toolCall;
    return true;
  }
  const field = kind === "text" ? "text" : "thinking";
  const current = isRec(content[index]) && content[index]!.type === kind ? content[index]! : { type: kind, [field]: "" };
  if (type === `${kind}_start`) content[index] = { type: kind, [field]: "" };
  else if (type === `${kind}_delta`) content[index] = { ...current, [field]: `${String(current[field] ?? "")}${typeof update.delta === "string" ? update.delta : ""}` };
  else if (type === `${kind}_end`) content[index] = { ...current, [field]: typeof update.content === "string" ? update.content : String(current[field] ?? "") };
  else return false;
  return true;
}

/** The copy keeps its own content array: delta folding must never write into the producer's event object. */
const ownedAssistant = (message: Rec): Rec => ({ ...message, content: Array.isArray(message.content) ? [...message.content] : [] });

/** Listener set shared by both transcripts: observer failures are swallowed and never reach the producer. */
export class TranscriptObservers {
  private listeners = new Set<() => void>();
  private released = false;
  get isReleased() { return this.released; }
  subscribe(listener: () => void): () => void {
    if (this.released) return () => {};
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  notify() {
    for (const listener of [...this.listeners]) try { listener(); } catch { /* observer failures never reach the producer */ }
  }
  /** First call only: runs `drop`, then notifies every listener one last time and forgets them. */
  release(drop: () => void) {
    if (this.released) return;
    this.released = true; drop();
    const listeners = [...this.listeners]; this.listeners.clear();
    for (const listener of listeners) try { listener(); } catch { /* observer failures never reach the producer */ }
  }
}

/**
 * In-memory copy of one child's conversation, built from the same RPC events the parent already receives.
 * Presentation only: never a record, never fed to a model. `release()` at the terminal state drops everything,
 * so the copy lives exactly as long as the task runs.
 */
export class LiveTranscript {
  readonly mode = "conversation" as const;
  private items: Item[] = [];
  private tools = new Map<string, ToolState>();
  private observers = new TranscriptObservers();
  version = 0;

  subscribe(listener: () => void): () => void { return this.observers.subscribe(listener); }
  get isReleased() { return this.observers.isReleased; }
  snapshot(): { items: readonly Item[]; tools: ReadonlyMap<string, ToolState> } { return { items: this.items, tools: this.tools }; }
  release() {
    this.observers.release(() => { this.items = []; this.tools = new Map(); this.version++; });
  }
  /** Mirrors the main TUI's event switch, minus anything that needs the host session. */
  ingest(event: unknown) {
    if (this.observers.isReleased || !isRec(event)) return;
    const message = isRec(event.message) ? event.message : undefined;
    let changed = true;
    switch (event.type) {
      case "message_start":
        if (message?.role === "user") this.items.push({ kind: "user", text: textOf(message.content) });
        else if (message?.role === "assistant") this.items.push({ kind: "assistant", message: ownedAssistant(message), streaming: true });
        else changed = false;
        break;
      case "message_update":
      case "message_end": {
        if (event.type === "message_update" && !message) { changed = this.foldDelta(event.assistantMessageEvent); break; }
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
    this.observers.notify();
  }
  /** Delta-only `message_update`: applies to the assistant message that is streaming, or starts one if its `message_start` was never seen. */
  private foldDelta(update: unknown): boolean {
    if (!isRec(update)) return false;
    const last = this.items[this.items.length - 1];
    const streaming = last?.kind === "assistant" && last.streaming ? last : undefined;
    const content = streaming && Array.isArray(streaming.message.content) ? [...streaming.message.content as Rec[]] : [];
    if (!foldBlockEvent(content, update)) return false;
    if (streaming) streaming.message = { ...streaming.message, content };
    else this.items.push({ kind: "assistant", message: { role: "assistant", content }, streaming: true });
    return true;
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
  private observers = new TranscriptObservers();
  version = 0;
  constructor(private limit = OUTPUT_TRANSCRIPT_BYTES) {}
  subscribe(listener: () => void): () => void { return this.observers.subscribe(listener); }
  get isReleased() { return this.observers.isReleased; }
  release() {
    this.observers.release(() => { this.buffer = Buffer.alloc(0); this.version++; });
  }
  /** Only the last `limit` bytes are kept; evicted bytes are counted, never retained. */
  append(chunk: Buffer) {
    if (this.observers.isReleased || !chunk.length) return;
    const data = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    if (data.length > this.limit) {
      // Do not start the kept tail inside a multi-byte character (a UTF-8 character has at most 3 continuation bytes): it would decode as U+FFFD.
      const first = data.length - this.limit;
      let start = first;
      while (start < data.length && start < first + 3 && (data[start]! & 0xc0) === 0x80) start++;
      this.dropped += start;
      this.buffer = Buffer.from(data.subarray(start));
    } else this.buffer = data;
    this.version++;
    this.observers.notify();
  }
  snapshot(): { text: string; truncated: boolean } { return { text: this.buffer.toString("utf8"), truncated: this.dropped > 0 }; }
}

/** Anything the jobs overlay can show as live detail for a running job. */
export type TranscriptSource = LiveTranscript | OutputTranscript | ScreenSource;

/**
 * A fixed-size terminal screen kept in memory (implemented by ScreenTranscript). `lines()` is the current screen as ready-to-print
 * rows with only SGR color codes; trailing blank rows are dropped, so the last row is the one the cursor or the output ends on.
 */
export interface ScreenSource {
  readonly mode: "screen";
  readonly version: number;
  readonly isReleased: boolean;
  subscribe(listener: () => void): () => void;
  lines(): string[];
  release(): void;
}

/** Renders a live copy with the host's own message components so it matches the main conversation view. */
export class TranscriptView extends Container {
  private builtVersion = -1;
  private builtExpanded = false;
  constructor(private source: TranscriptSource, private tui: TUI, private cwd: string, private expanded = false) { super(); }
  setExpanded(expanded: boolean) { this.expanded = expanded; }
  private rebuild() {
    this.clear();
    if (this.source.mode === "screen") return;
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
    // A screen is a grid: wrapping would shift its rows, so every row is cut at the panel width instead.
    if (this.source.mode === "screen") return this.source.lines().map(line => truncateToWidth(line, width, "", false));
    if (this.builtVersion !== this.source.version || this.builtExpanded !== this.expanded) this.rebuild();
    return super.render(width);
  }
}
