export interface StdoutProtocolState {
	buffer: string;
	finished: boolean;
}

/** Completes one assistant message, not the session (which may retry or continue). */
export function isTerminalAssistantStopReason(stopReason: unknown): boolean {
	return stopReason === "stop" || stopReason === "length" || stopReason === "error" || stopReason === "aborted";
}

/**
 * Split JSONL stdout without retaining data after the session-level terminal record.
 * The caller marks state.finished while processing a line that completes the protocol.
 */
export function consumeStdoutChunk(
	state: StdoutProtocolState,
	chunk: string,
	maxBufferedBytes: number,
	processLine: (line: string) => void,
): boolean {
	if (state.finished) return false;
	state.buffer += chunk;
	const lines = state.buffer.split("\n");
	state.buffer = lines.pop() || "";
	for (const line of lines) {
		if (Buffer.byteLength(line, "utf8") > maxBufferedBytes) return true;
		processLine(line);
		if (state.finished) {
			state.buffer = "";
			return false;
		}
	}
	return Buffer.byteLength(state.buffer, "utf8") > maxBufferedBytes;
}

/** One in-flight record; callers must await before consuming the next bounded pipe chunk. */
export async function consumeStdoutChunkAsync(
	state: StdoutProtocolState, chunk: string, maxBufferedBytes: number,
	processLine: (line: string) => Promise<void>,
): Promise<boolean> {
	let offset = 0;
	while (!state.finished && offset < chunk.length) {
		const newline = chunk.indexOf("\n", offset);
		const end = newline < 0 ? chunk.length : newline;
		const fragment = chunk.slice(offset, end);
		if (Buffer.byteLength(state.buffer, "utf8") + Buffer.byteLength(fragment, "utf8") > maxBufferedBytes) return true;
		state.buffer += fragment;
		if (newline < 0) break;
		const line = state.buffer;
		state.buffer = "";
		await processLine(line);
		offset = newline + 1;
	}
	if (state.finished) state.buffer = "";
	return false;
}
