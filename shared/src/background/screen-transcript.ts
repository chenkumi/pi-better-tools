import { release as osRelease } from "node:os";
import xterm from "@xterm/headless";
import { TranscriptObservers, type ScreenSource } from "./live-transcript.js";
import { terminalUnicode } from "./terminal-width.js";

const { Terminal } = xterm;

/** Repaint at most this often while output streams; a quiet terminal repaints at once. */
const NOTIFY_INTERVAL_MS = 100;
/** Characters that must never reach a text row: C0/C1 controls and bidi overrides/isolates. */
const UNSAFE = /[\x00-\x1f\x7f-\x9f؜‎‏‪-‮⁦-⁩]/g;

/**
 * In-memory copy of one terminal's screen, fed with the same bytes the terminal already produced. Presentation only:
 * not a record, never sent to a model, and not masked (the person at the keyboard sees what any terminal would show).
 * The grid keeps the terminal's own size; no scrollback is kept, so memory stays at cols × rows cells.
 * Only color SGR codes are generated here; nothing from the stream is passed through as an escape sequence.
 */
export class ScreenTranscript implements ScreenSource {
  readonly mode = "screen" as const;
  version = 0;
  private terminal?: InstanceType<typeof Terminal>;
  private observers = new TranscriptObservers();
  private timer?: ReturnType<typeof setTimeout>;
  private last = 0;
  private cache?: { version: number; rows: string[] };

  constructor(cols: number, rows: number) {
    // On Windows the child talks to ConPTY, which redraws and wraps lines itself; xterm needs to know to interpret that stream.
    const windowsPty = process.platform === "win32" ? { backend: "conpty" as const, buildNumber: windowsBuild() } : undefined;
    this.terminal = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true, windowsPty });
    this.terminal.unicode.register(terminalUnicode);
    this.terminal.unicode.activeVersion = terminalUnicode.version;
  }

  subscribe(listener: () => void): () => void { return this.observers.subscribe(listener); }
  get isReleased() { return this.observers.isReleased; }

  /** Feeds terminal output. The parser works asynchronously; the version changes once the bytes are applied. */
  write(data: string): void {
    const terminal = this.terminal;
    if (!terminal || !data) return;
    try { terminal.write(data, () => this.changed()); } catch { /* a screen is a convenience: it must never affect the session */ }
  }

  resize(cols: number, rows: number): void {
    try { this.terminal?.resize(cols, rows); this.changed(); } catch { /* same as write() */ }
  }

  release(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const terminal = this.terminal;
    this.terminal = undefined; this.cache = undefined;
    // xterm applies writes from a queue: dispose only after what is already queued has run, never underneath it.
    this.observers.release(() => {
      this.version++;
      if (!terminal) return;
      const dispose = () => { try { terminal.dispose(); } catch { /* already gone */ } };
      try { terminal.write("", dispose); } catch { dispose(); }
    });
  }

  private changed(): void {
    if (this.observers.isReleased) return;
    this.version++;
    if (this.timer) return;
    const wait = Math.max(0, this.last + NOTIFY_INTERVAL_MS - Date.now());
    this.timer = setTimeout(() => { this.timer = undefined; this.last = Date.now(); this.observers.notify(); }, wait);
    this.timer.unref?.();
  }

  /** Current screen rows up to the last row that has text or holds the cursor. */
  lines(): string[] {
    const terminal = this.terminal;
    if (!terminal) return [];
    if (this.cache?.version === this.version) return this.cache.rows;
    const buffer = terminal.buffer.active;
    const rows: string[] = [];
    let end = 0;
    for (let y = 0; y < terminal.rows; y++) {
      const line = buffer.getLine(buffer.baseY + y);
      const row = line ? render(line, terminal.cols) : "";
      rows.push(row);
      if (line?.translateToString(true).trim()) end = y + 1;
    }
    const shown = rows.slice(0, Math.max(end, Math.min(terminal.rows, buffer.cursorY + 1)));
    this.cache = { version: this.version, rows: shown };
    return shown;
  }
}

const windowsBuild = (): number => { const match = /^d+.d+.(d+)/.exec(osRelease()); return match ? Number(match[1]) : 0; };

type Line = NonNullable<ReturnType<InstanceType<typeof Terminal>["buffer"]["active"]["getLine"]>>;

/** One row as text with 16-color foreground and bold. Other attributes and 256/true colors are dropped. */
function render(line: Line, cols: number): string {
  let out = "", active = "";
  const cell = line.getCell(0);
  for (let x = 0; x < Math.min(cols, line.length) && cell; x++) {
    const c = line.getCell(x, cell);
    if (!c || c.getWidth() === 0) continue;
    const codes: number[] = [];
    if (c.isBold()) codes.push(1);
    if (c.isFgPalette()) { const color = c.getFgColor(); if (color < 8) codes.push(30 + color); else if (color < 16) codes.push(82 + color); }
    const next = codes.length ? `\x1b[${codes.join(";")}m` : "";
    if (next !== active) { out += next || "\x1b[0m"; active = next; }
    out += (c.getChars() || " ").replace(UNSAFE, "");
  }
  out = out.trimEnd(); // a stripped control character can leave a blank cell behind
  return active ? `${out}\x1b[0m` : out;
}
