import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { isBottomPanelOpen, openBottomPanel, whenBottomPanelFree, type BottomBody, type PanelStyle } from './host.js';

type DialogContext = Pick<ExtensionContext, 'mode' | 'hasUI'> & { ui: ExtensionContext['ui'] };
export interface DialogOptions { signal?: AbortSignal }

const usable = (ctx: DialogContext): boolean => ctx.mode === 'tui' && ctx.hasUI;

/** Resolves the panel as soon as the signal aborts, like the host dialogs do; returns the cleanup that drops the listener. */
function watch(signal: AbortSignal | undefined, abort: () => void): () => void {
  if (!signal) return () => undefined;
  if (signal.aborted) { queueMicrotask(abort); return () => undefined; }
  signal.addEventListener('abort', abort, { once: true });
  return () => signal.removeEventListener('abort', abort);
}

/** Another panel holds the keyboard: wait for it (a host dialog could not receive any key). False when the signal aborted first. */
async function waitTurn(options: DialogOptions): Promise<boolean> {
  while (isBottomPanelOpen()) if (!await whenBottomPanelFree(options.signal)) return false;
  return true;
}

/**
 * Yes/No question in the bottom panel. Esc and Ctrl+C answer No; the default focus is No so a stray Enter never approves.
 * A message taller than the room scrolls (↑/↓), so a long statement is never approved unseen. Outside the TUI, or when
 * another bottom panel is already open, it falls back to the host's own `ui.confirm`.
 */
export async function bottomConfirm(ctx: DialogContext, title: string, message: string, options: DialogOptions = {}): Promise<boolean> {
  if (usable(ctx)) {
    if (isBottomPanelOpen() && !await waitTurn(options)) return false; // open at once when nothing is in the way
    let unwatch = () => undefined as void;
    const answer = await openBottomPanel<boolean>(ctx.ui, {
      key: 'pi-better-tools-ask', title,
      create: ({ done, theme, rows }) => { unwatch = watch(options.signal, () => done(false)); return new ConfirmBody(message, theme, rows, done); },
    }).finally(() => unwatch());
    if (answer !== undefined) return answer;
  }
  return ctx.ui.confirm(title, message, options.signal ? { signal: options.signal } : undefined);
}

/** Pick one entry in the bottom panel; `undefined` when cancelled. Falls back to `ui.select` like `bottomConfirm`. */
export async function bottomSelect(ctx: DialogContext, title: string, options: readonly string[], dialog: DialogOptions = {}): Promise<string | undefined> {
  if (usable(ctx) && options.length) {
    if (isBottomPanelOpen() && !await waitTurn(dialog)) return undefined;
    let unwatch = () => undefined as void;
    const picked = await openBottomPanel<string | null>(ctx.ui, {
      key: 'pi-better-tools-ask', title,
      create: ({ done, theme, rows }) => { unwatch = watch(dialog.signal, () => done(null)); return new SelectBody(options, theme, rows, done); },
    }).finally(() => unwatch());
    if (picked !== undefined) return picked ?? undefined;
  }
  return ctx.ui.select(title, [...options], dialog.signal ? { signal: dialog.signal } : undefined);
}

const cancel = (data: string): boolean => matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c');

class ConfirmBody implements BottomBody {
  #yes = false;
  #scroll = 0;
  #pageRows = 5;
  constructor(private readonly message: string, private readonly style: PanelStyle, private readonly rows: () => number, private readonly done: (answer: boolean) => void) {}
  render(width: number): string[] {
    const s = this.style;
    const text = this.message.split('\n').flatMap(line => wrapTextWithAnsi(line, Math.max(10, width - 1))).map(line => truncateToWidth(line, width, '…', false));
    // Room for the message: the screen minus the editor, footer, chat context and this panel's own rows.
    this.#pageRows = Math.max(3, Math.min(text.length, this.rows() - 14));
    this.#scroll = Math.min(this.#scroll, Math.max(0, text.length - this.#pageRows));
    const shown = text.slice(this.#scroll, this.#scroll + this.#pageRows);
    const scrolls = text.length > this.#pageRows;
    const choice = (label: string, on: boolean) => on ? s.bold(s.fg('accent', `[ ${label} ]`)) : s.fg('dim', `[ ${label} ]`);
    const position = scrolls ? [s.fg('warning', `↑/↓ PgUp/PgDn scroll  lines ${this.#scroll + 1}-${this.#scroll + shown.length} of ${text.length}`)] : [];
    return ['', ...shown, ...position, '', `${choice('Yes', this.#yes)} ${choice('No', !this.#yes)}`, '', s.fg('dim', '←/→ choose  Enter confirm  Y yes  N no  Esc cancel')];
  }
  handleInput(data: string): void {
    if (cancel(data) || data === 'n' || data === 'N') return this.done(false);
    if (data === 'y' || data === 'Y') return this.done(true);
    if (matchesKey(data, 'enter')) return this.done(this.#yes);
    if (matchesKey(data, 'up')) this.#scroll = Math.max(0, this.#scroll - 1);
    else if (matchesKey(data, 'down')) this.#scroll++;
    else if (matchesKey(data, 'pageUp')) this.#scroll = Math.max(0, this.#scroll - this.#pageRows);
    else if (matchesKey(data, 'pageDown')) this.#scroll += this.#pageRows;
    else if (matchesKey(data, 'left') || matchesKey(data, 'right') || matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) this.#yes = !this.#yes;
  }
}

class SelectBody implements BottomBody {
  #at = 0;
  #room = 3;
  constructor(private readonly options: readonly string[], private readonly style: PanelStyle, private readonly rows: () => number, private readonly done: (picked: string | null) => void) {}
  render(width: number): string[] {
    const s = this.style, room = Math.min(this.options.length, Math.max(3, this.rows() - 10));
    this.#room = room;
    const from = Math.min(Math.max(0, this.#at - Math.floor(room / 2)), this.options.length - room);
    const lines = this.options.slice(from, from + room).map((option, i) => {
      const on = from + i === this.#at;
      return on ? s.fg('accent', `▸ ${truncateToWidth(option, width - 2)}`) : `  ${truncateToWidth(option, width - 2)}`;
    });
    return ['', ...lines, '', s.fg('dim', `↑/↓ PgUp/PgDn move  Enter select  Esc cancel${this.options.length > room ? `  (${this.#at + 1}/${this.options.length})` : ''}`)];
  }
  handleInput(data: string): void {
    if (cancel(data)) return this.done(null);
    if (matchesKey(data, 'enter')) return this.done(this.options[this.#at]!);
    if (matchesKey(data, 'up')) this.#at = (this.#at - 1 + this.options.length) % this.options.length;
    else if (matchesKey(data, 'down')) this.#at = (this.#at + 1) % this.options.length;
    else if (matchesKey(data, 'pageUp')) this.#at = Math.max(0, this.#at - this.#room);
    else if (matchesKey(data, 'pageDown')) this.#at = Math.min(this.options.length - 1, this.#at + this.#room);
  }
}
