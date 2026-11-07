import type { PanelUi } from '../../src/bottom-panel/index.ts';

/** A UI stand-in that records the widget and lets a test type into the captured terminal-input listener. */
export function fakeUi(options: { rows?: number } = {}) {
  const widgets = new Map<string, { render(width: number): string[]; dispose?(): void }>();
  const listeners = new Set<(data: string) => { consume?: boolean } | undefined>();
  const log: string[] = [];
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
  const tui = { requestRender: () => { log.push('render'); }, terminal: { rows: options.rows ?? 30 } };
  const ui = {
    setWidget(key: string, content: unknown, opts?: { placement?: string }) {
      log.push(`widget:${key}:${content === undefined ? 'clear' : 'set'}:${opts?.placement ?? ''}`);
      widgets.get(key)?.dispose?.();
      widgets.delete(key);
      if (typeof content === 'function') widgets.set(key, (content as (t: unknown, th: unknown) => { render(w: number): string[] })(tui, theme));
    },
    onTerminalInput(handler: (data: string) => { consume?: boolean } | undefined) {
      listeners.add(handler);
      return () => { listeners.delete(handler); };
    },
  } as unknown as PanelUi;
  return {
    ui, log, widgets,
    /** Sends keys through every listener like the host does; returns whether any consumed it. */
    type(data: string): boolean {
      for (const listener of [...listeners]) if (listener(data)?.consume) return true;
      return false;
    },
    listenerCount: () => listeners.size,
    render(key: string, width = 60): string[] { return widgets.get(key)?.render(width) ?? []; },
  };
}
