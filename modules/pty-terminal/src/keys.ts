const NAMED: Record<string, string> = {
	enter: "\r", tab: "\t", esc: "\x1b", space: " ", backspace: "\x7f", delete: "\x1b[3~", insert: "\x1b[2~",
	up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", home: "\x1b[H", end: "\x1b[F",
	pageup: "\x1b[5~", pagedown: "\x1b[6~", "shift-tab": "\x1b[Z",
	f1: "\x1bOP", f2: "\x1bOQ", f3: "\x1bOR", f4: "\x1bOS", f5: "\x1b[15~", f6: "\x1b[17~", f7: "\x1b[18~",
	f8: "\x1b[19~", f9: "\x1b[20~", f10: "\x1b[21~", f11: "\x1b[23~", f12: "\x1b[24~",
};
const ALIASES: Record<string, string> = { return: "enter", escape: "esc", del: "delete", pgup: "pageup", pgdn: "pagedown", pgdown: "pagedown", ins: "insert", bs: "backspace" };

/** Names accepted by pty_write `keys` (Ctrl-A..Ctrl-Z are generated). Aliases and case are normalized. */
export const KEY_NAMES: readonly string[] = [
	"Enter", "Tab", "Shift-Tab", "Esc", "Space", "Backspace", "Delete", "Insert", "Up", "Down", "Left", "Right",
	"Home", "End", "PageUp", "PageDown", "F1-F12", "Ctrl-A..Ctrl-Z",
];

/** Converts named keys to the terminal byte sequence; throws listing the supported names for an unknown key. */
export function resolveKeys(keys: readonly string[]): string {
	return keys.map(key => {
		const name = key.trim().toLowerCase().replace(/[+_\s]/g, "-").replace(/^(ctrl|control|c)-(?=[a-z]$)/, "ctrl-");
		const normalized = ALIASES[name] ?? name;
		const ctrl = /^ctrl-([a-z])$/.exec(normalized);
		if (ctrl) return String.fromCharCode(ctrl[1].charCodeAt(0) - 96);
		const sequence = Object.hasOwn(NAMED, normalized) ? NAMED[normalized] : undefined;
		if (sequence === undefined) throw new Error(`Unknown key "${key.slice(0, 40)}". Supported keys: ${KEY_NAMES.join(", ")} (case-insensitive; Ctrl+C, C-c also accepted).`);
		return sequence;
	}).join("");
}
