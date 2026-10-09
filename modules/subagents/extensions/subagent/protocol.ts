export interface StdoutProtocolState {
	buffer: string;
	finished: boolean;
	/** Running UTF-8 size of `buffer` maintained by consumeStdoutChunkAsync (avoids rescanning the buffer per chunk). */
	bufferBytes?: number;
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
	// Trust the counter only while it describes the current buffer (callers may reset `buffer` directly).
	let buffered = state.buffer === "" ? 0 : state.bufferBytes ?? Buffer.byteLength(state.buffer, "utf8");
	while (!state.finished && offset < chunk.length) {
		const newline = chunk.indexOf("\n", offset);
		const end = newline < 0 ? chunk.length : newline;
		const fragment = chunk.slice(offset, end);
		const fragmentBytes = Buffer.byteLength(fragment, "utf8");
		if (buffered + fragmentBytes > maxBufferedBytes) { state.bufferBytes = buffered; return true; }
		state.buffer += fragment;
		buffered += fragmentBytes;
		if (newline < 0) break;
		const line = state.buffer;
		state.buffer = "";
		buffered = 0;
		state.bufferBytes = 0;
		await processLine(line);
		offset = newline + 1;
	}
	state.bufferBytes = buffered;
	if (state.finished) state.buffer = "";
	return false;
}
