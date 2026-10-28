import type { Component } from "@earendil-works/pi-tui";
import { decodeKittyPrintable, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

const NOTICE = "The text you type goes straight to the session; the agent never sees it.";

export interface SecretInputOptions {
	/** Lines shown above the field (the agent's prompt, or the session facts when it gave none). */
	header: string[];
	onSubmit(value: string): void;
	onCancel(): void;
	requestRender?(): void;
}

/**
 * Single-line masked input. Deliberately not pi-tui's Input: no undo stack, kill ring or getValue(); the typed value
 * lives in one private field and leaves the component only through onSubmit. Rendering shows one `*` per code point
 * (bounded by the box width) and the exact count to the local user, but not the input itself.
 */
export class SecretInput implements Component {
	#value = "";
	#paste: string | undefined;
	#done = false;
	focused = false;
	readonly #options: SecretInputOptions;

	constructor(options: SecretInputOptions) {
		this.#options = options;
	}

	handleInput(data: string): void {
		if (this.#done) return;
		if (this.#paste !== undefined || data.includes(PASTE_START)) return this.#handlePaste(data);
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return this.#finish(() => this.#options.onCancel());
		if (matchesKey(data, "enter")) {
			const value = this.#value;
			return this.#finish(() => this.#options.onSubmit(value));
		}
		if (matchesKey(data, "backspace")) {
			this.#value = Array.from(this.#value).slice(0, -1).join("");
			this.#options.requestRender?.();
			return;
		}
		if (matchesKey(data, "ctrl+u")) {
			this.#value = "";
			this.#options.requestRender?.();
			return;
		}
		const printable = decodeKittyPrintable(data) ?? (data.startsWith("\x1b") ? undefined : data);
		if (printable !== undefined) this.#append(printable);
	}

	#handlePaste(data: string): void {
		let chunk = data;
		if (this.#paste === undefined) {
			this.#paste = "";
			chunk = data.slice(data.indexOf(PASTE_START) + PASTE_START.length);
		}
		this.#paste += chunk;
		const end = this.#paste.indexOf(PASTE_END);
		if (end === -1) return;
		const pasted = this.#paste.slice(0, end);
		this.#paste = undefined;
		this.#append(pasted.replace(/[\r\n]+/g, ""));
	}

	/** Control characters other than the pasted text itself are never stored. */
	#append(text: string): void {
		this.#value += Array.from(text).filter((char) => { const code = char.codePointAt(0)!; return code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f); }).join("");
		this.#options.requestRender?.();
	}

	#finish(callback: () => void): void {
		this.#done = true;
		this.#paste = undefined;
		this.#value = "";
		callback();
	}

	/** Drop the typed value without reporting it (dispose after an external close). */
	dispose(): void {
		this.#done = true;
		this.#paste = undefined;
		this.#value = "";
	}

	invalidate(): void {}

	render(width: number): string[] {
		const w = Math.max(24, width);
		const count = Array.from(this.#value).length;
		const title = "╭─ PTY KeyIn ";
		const counter = ` ${count} chars ─`;
		const room = w - 4; // "│ " + field + " │" borders
		const field = ("*".repeat(Math.min(count, room - 1)) + "_").padEnd(room);
		return [
			"─".repeat(w),
			...this.#options.header.map((line) => ` ${line}`),
			`${title}${"─".repeat(w - title.length - 1)}╮`,
			`│ ${field} │`,
			`╰${"─".repeat(w - 2 - counter.length)}${counter}╯`,
			` ${NOTICE}`,
		].map((line) => truncateToWidth(line, Math.max(1, width)));
	}
}
