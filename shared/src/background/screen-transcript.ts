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
 * Only SGR styling (bold, dim, italic, underline, inverse, strikethrough, 16/256/true colors) is generated here; nothing from
 * the stream is passed through as an escape sequence.
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

type Cell = NonNullable<ReturnType<Line["getCell"]>>;

/** SGR parameters of a color: palette 0-15 use the classic codes, 16-255 and RGB the extended forms. */
function colorCodes(base: 30 | 40, palette: boolean, rgb: boolean, value: number): number[] {
  if (rgb) return [base + 8, 2, (value >> 16) & 255, (value >> 8) & 255, value & 255];
  if (!palette) return [];
  if (value < 8) return [base + value];
  if (value < 16) return [base + 60 + value - 8];
  return [base + 8, 5, value & 255];
}

/** The SGR parameters that reproduce a cell's look (empty for the default look). The only escape sequences this module ever emits. */
function styleOf(c: Cell): string {
  const codes: number[] = [];
  if (c.isBold()) codes.push(1);
  if (c.isDim()) codes.push(2);
  if (c.isItalic()) codes.push(3);
  if (c.isUnderline()) codes.push(4);
  if (c.isInverse()) codes.push(7);
  if (c.isStrikethrough()) codes.push(9);
  codes.push(...colorCodes(30, c.isFgPalette(), c.isFgRGB(), c.getFgColor()));
  codes.push(...colorCodes(40, c.isBgPalette(), c.isBgRGB(), c.getBgColor()));
  return codes.join(";");
}

/** One row as text with bold, dim, italic, underline, inverse, strikethrough and 16/256/true colors. Nothing else survives. */
function render(line: Line, cols: number): string {
  const cells: Array<{ text: string; style: string; blank: boolean }> = [];
  const cell = line.getCell(0);
  for (let x = 0; x < Math.min(cols, line.length) && cell; x++) {
    const c = line.getCell(x, cell);
    if (!c || c.getWidth() === 0) continue; // the right half of a wide glyph
    const style = styleOf(c);
    // Hidden text (a password prompt) stays hidden; a blank cell only counts when it is visibly painted.
    const text = c.isInvisible() ? " " : (c.getChars() || " ").replace(UNSAFE, "");
    cells.push({ text, style, blank: text.trim() === "" && !c.isInverse() && !c.isBgPalette() && !c.isBgRGB() });
  }
  let end = cells.length;
  while (end > 0 && cells[end - 1]!.blank) end--;
  let out = "", active = "";
  for (const { text, style } of cells.slice(0, end)) {
    if (style !== active) { out += style ? `[0;${style}m` : "[0m"; active = style; }
    out += text;
  }
  return active ? `${out}[0m` : out;
}
