import { stripVTControlCharacters } from "node:util";

export const MAX_TITLE_LENGTH = 50;
const MAX_TITLE_BYTES = 4096;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Pure display preview; tolerate incomplete inputs and older saved details. */
export function displayTitle(value: unknown): string {
	if (typeof value !== "string") return "";
	const clean = stripVTControlCharacters(value.slice(0, 4096))
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "")
		.replace(/\s+/gu, " ").trim();
	let text = "", count = 0;
	for (const { segment } of graphemes.segment(clean)) {
		if (count++ === MAX_TITLE_LENGTH) break;
		text += segment;
	}
	return text;
}

export function isValidTitle(value: unknown): boolean {
	if (value === undefined) return true;
	if (typeof value !== "string" || value.length > MAX_TITLE_BYTES || Buffer.byteLength(value, "utf8") > MAX_TITLE_BYTES || !displayTitle(value)) return false;
	let count = 0;
	// JSON Schema string lengths are Unicode code points, not UTF-16 units.
	// Enforce this again here because host validators may count graphemes instead.
	for (const _ of value) if (++count > MAX_TITLE_LENGTH) return false;
	return true;
}
