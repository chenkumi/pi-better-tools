/**
 * Masks secrets that the user typed through pty_keyin wherever they reappear in PTY output (for example a password that a timed-out
 * prompt hands to the shell, which then echoes it as a command). Exact-text matching only: a transformed secret (base64, quoted,
 * truncated) is not recognised. Matching tolerates escape sequences, CR/LF and backspaces between the characters, because echo can
 * be interleaved with cursor movement or line wrapping.
 */
export const MASK = "********";
/** CSI, OSC, two-character escapes, CR, LF and backspace: what may sit between two echoed characters. */
const GAP = String.raw`(?:\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]|[\r\n\b])*`;
/** How far back from the end of the text a trailing partial secret is looked for. */
const TAIL_WINDOW = 4096;

const identity = (index: number): number => index;
const literal = (ch: string): string => /[\x00-\x1f\x7f]/.test(ch) ? `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}` : ch.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

export interface MaskedView {
	/** Output with every complete secret replaced by MASK; excludes the held-back tail. */
	text: string;
	/** Complete secrets replaced. */
	count: number;
	/** Offset in the raw input where `text` begins: the requested `from`, or the end of a secret that `from` fell inside. */
	rawStart: number;
	/** End offset in the raw input that `text` accounts for; the rest is held back. */
	rawLength: number;
	/** Maps an offset into `text` to an offset relative to `rawStart` (an offset inside a mask maps to where the secret started). */
	toRaw(index: number): number;
}

export class SecretMasker {
	private secrets: string[] = [];
	private full?: RegExp;
	private tail?: RegExp;

	get size(): number { return this.secrets.length; }

	/** Registers a secret; returns false for an empty or already known value. */
	add(secret: string): boolean {
		if (!secret || this.secrets.includes(secret)) return false;
		this.secrets.push(secret);
		this.secrets.sort((a, b) => [...b].length - [...a].length); // longest first so a secret that contains another is masked whole
		const fulls: string[] = [], tails: string[] = [];
		for (const value of this.secrets) {
			const chars = [...value].map(literal);
			fulls.push(chars.join(GAP));
			// A proper prefix of at least one character, optionally followed by escapes, at the very end of the text.
			if (chars.length > 1) {
				let nested = chars[chars.length - 2];
				for (let i = chars.length - 3; i >= 0; i--) nested = `${chars[i]}(?:${GAP}${nested})?`;
				tails.push(nested);
			}
		}
		this.full = new RegExp(`(?:${fulls.join("|")})`, "g");
		this.tail = tails.length ? new RegExp(`(?:${tails.join("|")})${GAP}$`) : undefined;
		return true;
	}

	/** Forgets every secret (session released). */
	clear(): void { this.secrets = []; this.full = undefined; this.tail = undefined; }

	/**
	 * `final` releases the held-back tail (the session ended, nothing more can complete it). Otherwise a trailing run that could be
	 * the beginning of a secret is withheld so that a secret split across two reads is never shown in halves.
	 * `from` starts the visible text mid-way, but secrets are still matched over all of `raw`: a start inside a secret skips the rest of
	 * that secret instead of showing its tail.
	 */
	view(raw: string, final = false, from = 0): MaskedView {
		from = Math.min(Math.max(from, 0), raw.length);
		if (!this.full) return { text: raw.slice(from), count: 0, rawStart: from, rawLength: raw.length, toRaw: identity };
		let matches: Array<{ start: number; end: number }> = [];
		this.full.lastIndex = 0;
		for (let m = this.full.exec(raw); m; m = this.full.exec(raw)) {
			if (m[0].length === 0) { this.full.lastIndex++; continue; }
			matches.push({ start: m.index, end: m.index + m[0].length });
		}
		const straddling = matches.find((match) => match.start < from && from < match.end);
		const begin = straddling ? straddling.end : from;
		const lastEnd = matches.length ? matches[matches.length - 1].end : 0;
		matches = matches.filter((match) => match.start >= begin);
		let visible = raw.length;
		if (!final && this.tail) {
			const tailFrom = Math.max(0, raw.length - TAIL_WINDOW);
			const held = this.tail.exec(raw.slice(tailFrom));
			if (held && tailFrom + held.index >= lastEnd) visible = Math.max(begin, tailFrom + held.index);
		}
		let text = "", cursor = begin;
		const segments: Array<{ rawStart: number; rawEnd: number; outStart: number; outEnd: number }> = [];
		for (const { start, end } of matches) {
			text += raw.slice(cursor, start);
			segments.push({ rawStart: start, rawEnd: end, outStart: text.length, outEnd: text.length + MASK.length });
			text += MASK;
			cursor = end;
		}
		text += raw.slice(cursor, Math.max(cursor, visible));
		return {
			text,
			count: matches.length,
			rawStart: begin,
			rawLength: Math.max(begin, visible),
			toRaw: matches.length === 0 ? identity : (index: number) => {
				let shift = 0;
				for (const segment of segments) {
					if (index < segment.outStart) break;
					if (index < segment.outEnd) return segment.rawStart - begin;
					shift = segment.rawEnd - begin - segment.outEnd;
				}
				return index + shift;
			},
		};
	}
}
