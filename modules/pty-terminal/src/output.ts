export const MAX_OUTPUT_BYTES = 50 * 1024;
export const MAX_OUTPUT_LINES = 2_000;
/** Unterminated OSC/DCS-style strings longer than this are not treated as one sequence. */
const MAX_STRING_SEQUENCE = 8_192;

export type OutputFormat = "raw" | "text";

export interface TruncatedOutput {
	content: string;
	truncated: boolean;
	/** Output not included in `content`; callers should leave it in (or return it to) the session buffer. */
	remainder: string;
}

export interface TruncateOptions {
	/** "text" strips ANSI escape sequences (CSI/OSC/DCS/other ESC); default "raw" keeps everything. */
	format?: OutputFormat;
	/** False while more output may still arrive: an escape sequence cut off at the end is then held back (text only). Default true. */
	final?: boolean;
}

/**
 * Length in UTF-16 units of the escape sequence starting at `output[index]` (which must be ESC),
 * or -1 when the sequence is not complete before the end of `output`.
 */
export function escapeLength(output: string, index: number): number {
	const end = output.length;
	if (index + 1 >= end) return -1;
	const kind = output.charCodeAt(index + 1);
	if (kind === 0x5b) { // CSI: parameters 0x30-0x3f, intermediates 0x20-0x2f, final 0x40-0x7e
		for (let j = index + 2; j < end; j++) {
			const code = output.charCodeAt(j);
			if (code >= 0x40 && code <= 0x7e) return j - index + 1;
			if (code < 0x20 || code > 0x3f) return j - index; // malformed: stop before the offending character
		}
		return -1;
	}
	if (kind === 0x5d || kind === 0x50 || kind === 0x58 || kind === 0x5e || kind === 0x5f) { // OSC, DCS, SOS, PM, APC
		const limit = Math.min(end, index + 2 + MAX_STRING_SEQUENCE);
		for (let j = index + 2; j < limit; j++) {
			const code = output.charCodeAt(j);
			if (code === 0x07) return j - index + 1;
			if (code === 0x1b) {
				if (j + 1 >= end) return -1;
				return output.charCodeAt(j + 1) === 0x5c ? j - index + 2 : j - index; // ST, or a new escape starts
			}
		}
		return limit === end ? -1 : limit - index;
	}
	let j = index + 1; // ESC, intermediates 0x20-0x2f, final 0x30-0x7e
	while (j < end && output.charCodeAt(j) >= 0x20 && output.charCodeAt(j) <= 0x2f) j++;
	if (j >= end) return -1;
	const code = output.charCodeAt(j);
	return code >= 0x30 && code <= 0x7e ? j - index + 1 : j - index;
}

/** UTF-8 size of the UTF-16 range, without allocating a Buffer per character. */
function utf8Length(text: string, start: number, end: number): number {
	let bytes = 0;
	for (let i = start; i < end; i++) {
		const code = text.charCodeAt(i);
		if (code < 0x80) bytes += 1;
		else if (code < 0x800) bytes += 2;
		else if (code >= 0xd800 && code < 0xdc00 && i + 1 < end && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { bytes += 4; i++; }
		else bytes += 3;
	}
	return bytes;
}

/** Removes complete escape sequences; an incomplete trailing sequence is dropped. */
export function stripEscapes(output: string): string {
	if (!output.includes("\x1b")) return output;
	let result = "";
	let run = 0;
	for (let i = output.indexOf("\x1b"); i !== -1; i = output.indexOf("\x1b", run)) {
		result += output.slice(run, i);
		const length = escapeLength(output, i);
		run = length < 0 ? output.length : i + length;
	}
	return result + output.slice(run);
}

/**
 * Keep custom tool output within Pi's documented default context limits. Escape sequences are never
 * split: a cut that would land inside one moves before it. Text format counts only visible characters.
 */
export function truncatePtyOutput(output: string, options: TruncateOptions = {}): TruncatedOutput {
	const text = options.format === "text";
	const final = options.final ?? true;
	const length = output.length;
	let bytes = 0;
	let newlines = 0;
	let i = 0;
	let run = 0; // start of the pending visible run (text format)
	let visible = "";
	let held = false;

	while (i < length) {
		const code = output.charCodeAt(i);
		if (code === 0x1b) {
			let unit = escapeLength(output, i);
			if (unit < 0) {
				if (text && !final) { held = true; break; }
				unit = length - i;
			}
			if (text) {
				visible += output.slice(run, i);
				i += unit;
				run = i;
				continue;
			}
			const unitBytes = utf8Length(output, i, i + unit);
			if (bytes + unitBytes > MAX_OUTPUT_BYTES) break;
			bytes += unitBytes;
			i += unit;
			continue;
		}
		let width = 1;
		let charBytes: number;
		if (code < 0x80) charBytes = 1;
		else if (code < 0x800) charBytes = 2;
		else if (code >= 0xd800 && code < 0xdc00 && i + 1 < length && (output.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { width = 2; charBytes = 4; }
		else charBytes = 3;
		if (bytes + charBytes > MAX_OUTPUT_BYTES || (code === 10 && newlines >= MAX_OUTPUT_LINES)) break;
		bytes += charBytes;
		if (code === 10) newlines += 1;
		i += width;
	}

	const body = text ? visible + output.slice(run, i) : output.slice(0, i);
	if (i === length) return { content: body, truncated: false, remainder: "" };
	if (held) return { content: body, truncated: false, remainder: output.slice(i) };
	return {
		content:
			body +
			`\n\n[PTY output truncated at ${MAX_OUTPUT_LINES} lines or ${MAX_OUTPUT_BYTES} bytes; ${length - i} more characters remain buffered. Read again for later output.]`,
		truncated: true,
		remainder: output.slice(i),
	};
}
