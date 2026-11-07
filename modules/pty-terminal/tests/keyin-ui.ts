/** A UI stand-in for the bottom panel: records the widget and lets a test type into the captured terminal-input listener. */
export function keyinUi() {
	const state: { shown: number; cleared: number; component?: { render(width: number): string[] } } = { shown: 0, cleared: 0 };
	let listener: ((data: string) => { consume?: boolean } | undefined) | undefined;
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const ui = {
		setWidget(_key: string, content: unknown) {
			if (typeof content === "function") { state.shown++; state.component = (content as (tui: unknown, theme: unknown) => { render(width: number): string[] })({ requestRender() {}, terminal: { rows: 30 } }, theme); } else { state.cleared++; state.component = undefined; }
		},
		onTerminalInput(handler: (data: string) => { consume?: boolean } | undefined) { listener = handler; return () => { listener = undefined; }; },
	};
	return { ui, state, type: (text: string) => listener?.(text), screen: () => state.component?.render(60) ?? [] };
}
