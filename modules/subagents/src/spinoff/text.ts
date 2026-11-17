/** A thrown value's message (or the value itself), optionally capped to `max` characters. */
export const errorText = (error: unknown, max?: number) => String((error as Error)?.message ?? error).slice(0, max);

/** The longest prefix of `text` within `maxBytes` UTF-8 bytes that does not split a multi-byte sequence. */
export function utf8Prefix(text: string, maxBytes: number): string {
	const raw = Buffer.from(text, "utf8");
	if (raw.length <= maxBytes) return text;
	let end = maxBytes;
	while (end > 0 && (raw[end]! & 0xc0) === 0x80) end--;
	return raw.subarray(0, end).toString("utf8");
}
