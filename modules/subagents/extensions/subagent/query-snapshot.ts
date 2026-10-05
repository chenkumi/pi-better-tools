import { SessionManager, convertToLlm, type SessionEntry, type SessionHeader } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";

export const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
export const MAX_INTERACTION_BYTES = 64 * 1024;
// Allow JSON escaping of 8 KiB answers and bounded asOf IDs, not more text.
export const MAX_QUERY_REPLY_BYTES = 128 * 1024;
export const CONTROL_PREFIX = "[Delegated user control ";
export function controlText(id: string, message: string) { return `${CONTROL_PREFIX}${id}]\n${message}`; }
export function controlId(text: string) { return /^\[Delegated user control ([a-z0-9]+)\]\n/.exec(text)?.[1]; }
export function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.filter(part => part?.type === "text").map(part => part.text).join("\n") : "";
}
export function validateInteraction(message: unknown): asserts message is string {
	if (typeof message !== "string" || !message.trim() || Buffer.byteLength(message, "utf8") > MAX_INTERACTION_BYTES) throw new Error("INVALID_MESSAGE: nonblank literal text of at most 64 KiB required");
}
/** Validate provider pairing, never repair/reorder or discard opaque message fields. */
export function pendingTools(messages: Message[]): Set<string> {
	const pending = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant") {
			if (pending.size) throw new Error("UNSAFE_SNAPSHOT: assistant before paired tool results");
			for (const part of message.content) if (part.type === "toolCall") {
				if (pending.has(part.id)) throw new Error("UNSAFE_SNAPSHOT: duplicate tool call");
				pending.add(part.id);
			}
		} else if (message.role === "toolResult") {
			if (!pending.delete(message.toolCallId)) throw new Error("UNSAFE_SNAPSHOT: orphan or duplicate tool result");
		} else if (message.role === "user" && pending.size) throw new Error("UNSAFE_SNAPSHOT: user before paired tool results");
	}
	return pending;
}
export function safeSnapshot(header: SessionHeader, entries: SessionEntry[], sourceLeafId: string | null, effectivePrompt: string) {
	if (entries.length > 16384) throw new Error("SNAPSHOT_CAPACITY: canonical snapshot exceeds 16384 entries");
	let bytes = 0;
	for (const entry of entries) { bytes += Buffer.byteLength(JSON.stringify(entry), "utf8"); if (bytes > MAX_SNAPSHOT_BYTES) throw new Error("SNAPSHOT_CAPACITY: canonical snapshot exceeds 8 MiB"); }
	let previous: string | null = null;
	const ids = new Set<string>();
	for (const entry of entries) {
		if (entry.parentId !== previous || ids.has(entry.id)) throw new Error("UNSAFE_SNAPSHOT: managed session must be a single canonical chain");
		ids.add(entry.id); previous = entry.id;
	}
	if (previous !== sourceLeafId) throw new Error("UNSAFE_SNAPSHOT: native leaf identity mismatch");
	// Find the latest complete raw assistant/tool batch. Context edits and
	// compaction are then replayed canonically and validated a second time.
	let safeLength = 0; const pending = new Set<string>();
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (entry.type === "message") {
			const message = entry.message;
			if (message.role === "assistant") {
				if (pending.size) throw new Error("UNSAFE_SNAPSHOT: overlapping assistant/tool batches");
				for (const part of message.content) if (part.type === "toolCall") {
					if (pending.has(part.id)) throw new Error("UNSAFE_SNAPSHOT: duplicate raw tool call"); pending.add(part.id);
				}
			} else if (message.role === "toolResult") {
				if (!pending.delete(message.toolCallId)) throw new Error("UNSAFE_SNAPSHOT: orphan raw tool result");
			} else if (message.role === "user" && pending.size) throw new Error("UNSAFE_SNAPSHOT: user inside unfinished tool batch");
		}
		if (!pending.size) safeLength = index + 1;
	}
	const prefix = structuredClone(entries.slice(0, safeLength));
	const ephemeral = SessionManager.inMemory(header.cwd, { id: header.id }, [structuredClone(header), ...prefix]);
	if (ephemeral.getSessionId() !== header.id || ephemeral.getEntries().length !== prefix.length || ephemeral.getLeafId() !== (prefix.at(-1)?.id ?? null)) throw new Error("QUERY_HOST_UNSUPPORTED: inMemory did not replay the supplied canonical entries/leaf");
	const context = ephemeral.buildSessionContext();
	const messages = convertToLlm(context.messages);
	if (pendingTools(messages).size) throw new Error("UNSAFE_SNAPSHOT: compaction/context edit left unpaired tools");
	// Remove executable tool declarations at every replayed system checkpoint,
	// while retaining prompt sections and provider opaque message metadata.
	const noTools: Message[] = messages.map(message => message.role === "system" ? { ...message, toolsAdded: [], toolsRemoved: [] } : message);
	if (!noTools.some(message => message.role === "system")) noTools.unshift({ role: "system", content: effectivePrompt, toolsAdded: [], timestamp: Date.now() });
	const leaf = prefix.at(-1);
	return { messages: noTools, thinkingLevel: context.thinkingLevel,
		asOf: { entryId: leaf?.id ?? null, timestamp: leaf?.timestamp ?? header.timestamp, capturedAt: new Date().toISOString(), sourceLeafId,
			sourceTurn: { assistantOrdinal: prefix.filter(entry => entry.type === "message" && entry.message.role === "assistant").length, userOrdinal: prefix.filter(entry => entry.type === "message" && entry.message.role === "user").length },
			stale: (leaf?.id ?? null) !== sourceLeafId, pendingToolCallIds: [...pending].slice(0, 64).map(id => id.slice(0, 128)), pendingToolCallCount: pending.size, pendingToolCallIdsTruncated: pending.size > 64 || [...pending].some(id => id.length > 128),
			appliedControlIds: prefix.flatMap(entry => entry.type === "message" && entry.message.role === "user" ? [controlId(messageText(entry.message.content))].filter((id): id is string => Boolean(id)) : []).slice(-32) } };
}
