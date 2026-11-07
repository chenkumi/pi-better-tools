import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import type { Component, TUI } from '@earendil-works/pi-tui';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

export interface PanelStyle { fg(color: string, text: string): string; bold(text: string): string }

/** What a panel body has to provide. The frame (the title rule) is drawn by the host. */
export interface BottomBody {
  /** Content rows for `width` columns. Every row must fit; the host clips defensively. */
  render(width: number): string[];
  handleInput(data: string): void;
  dispose?(): void;
}

export interface BottomPanelContext<T> {
  done(result: T): void;
  requestRender(): void;
  rows(): number;
  theme: PanelStyle;
  /** The host TUI, for bodies that embed host components (they need it to render). */
  tui: TUI;
}

export interface BottomPanelOptions<T> {
  /** Widget key; only one bottom panel is open at a time, whatever the key. */
  key: string;
  /** Text in the top rule. A function is re-read on every draw (for example to show an unsaved mark). */
  title: string | (() => string);
  create(context: BottomPanelContext<T>): BottomBody;
}

/** The part of the UI context the host needs; everything else stays with the host application. */
export type PanelUi = Pick<ExtensionUIContext, 'setWidget' | 'onTerminalInput'>;

/** SGR mouse reports and focus events are never consumed, so wheel scrolling, click regions and focus tracking keep working. */
const PASSTHROUGH = /^(?:\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[[IO])$/;

const ACTIVE = Symbol.for('pi-better-tools:bottom-panel:active');
type Registry = { [ACTIVE]?: { close(): void } };
const registry = globalThis as unknown as Registry;

const waiters = new Set<() => void>();

/**
 * Resolves true once no bottom panel is open, or false when the signal aborts first. A question raised while a panel holds the
 * keyboard waits here instead of falling back to a host dialog that could never receive a key.
 */
export function whenBottomPanelFree(signal?: AbortSignal): Promise<boolean> {
  if (!registry[ACTIVE]) return Promise.resolve(true);
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise<boolean>(resolve => {
    const wake = () => { signal?.removeEventListener('abort', abort); resolve(true); };
    const abort = () => { waiters.delete(wake); resolve(false); };
    waiters.add(wake);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** True while a bottom panel owns the keyboard. */
export function isBottomPanelOpen(): boolean { return registry[ACTIVE] !== undefined; }

/** Closes whatever bottom panel is open (session switch, shutdown). Safe when none is open. */
export function closeBottomPanel(): void { registry[ACTIVE]?.close(); }

/**
 * Shows a panel in the area above the editor, keeps the editor and footer visible, and routes keyboard input to the body
 * until it calls `done`. Resolves with the value passed to `done`, or `undefined` when another panel is already open, the
 * UI could not show it, or the panel was closed from outside (`closeBottomPanel`).
 */
export function openBottomPanel<T>(ui: PanelUi, options: BottomPanelOptions<T>): Promise<T | undefined> {
  if (registry[ACTIVE]) return Promise.resolve(undefined);
  return new Promise<T | undefined>(resolve => {
    let finished = false;
    let body: BottomBody | undefined;
    let unsubscribe: (() => void) | undefined;
    let tui: TUI | undefined;
    const handle = { close: () => finish(undefined) };
    function finish(result: T | undefined): void {
      if (finished) return;
      finished = true;
      if (registry[ACTIVE] === handle) delete registry[ACTIVE];
      for (const wake of [...waiters]) { waiters.delete(wake); queueMicrotask(wake); }
      try { unsubscribe?.(); } catch { /* disposed terminal */ }
      try { body?.dispose?.(); } catch { /* the body is going away */ }
      try { ui.setWidget(options.key, undefined, { placement: 'aboveEditor' }); } catch { /* disposed terminal */ }
      resolve(result);
    }
    registry[ACTIVE] = handle;
    try {
      ui.setWidget(options.key, (host, theme) => {
        tui = host;
        const style = theme as unknown as PanelStyle;
        body = options.create({ done: result => finish(result), requestRender: () => { try { host.requestRender(); } catch { /* disposed terminal */ } }, rows: () => host.terminal?.rows ?? 24, theme: style, tui: host });
        const component: Component & { dispose(): void } = {
          invalidate() {},
          render: width => frame(style, typeof options.title === 'function' ? options.title() : options.title, body!.render(Math.max(1, width - 2)), width),
          dispose() { /* the body is disposed by finish(), after the widget is gone */ },
        };
        return component;
      }, { placement: 'aboveEditor' });
      if (finished) { try { ui.setWidget(options.key, undefined, { placement: 'aboveEditor' }); } catch { /* disposed terminal */ } return; } // the body finished while it was being created
      unsubscribe = ui.onTerminalInput(data => {
        if (finished || PASSTHROUGH.test(data)) return undefined;
        try { body?.handleInput(data); } catch { /* a faulty body must not leak keys into the editor or crash the host */ }
        try { tui?.requestRender(); } catch { /* disposed terminal */ }
        return { consume: true };
      });
    } catch {
      finish(undefined);
    }
  });
}

/** Title rule on top and a one-column gutter (the editor's own border follows the body). */
export function frame(style: PanelStyle, title: string, body: readonly string[], width: number, clip = true): string[] {
  const w = Math.max(0, width);
  if (!body.length) return []; // a body that has closed (or has nothing to show) draws no empty frame
  const head = `── ${title} `;
  const top = style.fg('accent', head.slice(0, Math.max(0, w - 1))) + style.fg('accent', '─'.repeat(Math.max(0, w - visibleWidth(head))));
  return [
    truncateToWidth(top, w),
    ...body.map(row => clip ? truncateToWidth(` ${row}`, w, '…', false) : ` ${row}`),
  ];
}
