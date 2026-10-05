export const MAX_OUTPUT_BYTES = 50 * 1024;
export const MAX_OUTPUT_LINES = 2_000;

export interface TruncatedOutput {
	content: string;
	truncated: boolean;
	/** Output cut off from `content`; callers should return it to the session buffer. */
	remainder: string;
}

/** Keep custom tool output within Pi's documented default context limits. */
export function truncatePtyOutput(output: string): TruncatedOutput {
	let bytes = 0;
	let newlines = 0;
	let end = 0;

	for (const char of output) {
		const charBytes = Buffer.byteLength(char);
		if (bytes + charBytes > MAX_OUTPUT_BYTES || (char === "\n" && newlines >= MAX_OUTPUT_LINES)) break;
		bytes += charBytes;
		if (char === "\n") newlines += 1;
		end += char.length;
	}

	if (end === output.length) return { content: output, truncated: false, remainder: "" };
	return {
		content:
			output.slice(0, end) +
			`\n\n[PTY output truncated at ${MAX_OUTPUT_LINES} lines or ${MAX_OUTPUT_BYTES} bytes. Read again for later output.]`,
		truncated: true,
		remainder: output.slice(end),
	};
}
