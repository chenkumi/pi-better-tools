import * as fs from "node:fs";
import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, SessionHeader, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ThinkingLevel } from "@earendil-works/pi-ai";
import { safeSnapshot, validateInteraction, messageText, MAX_INTERACTION_BYTES, MAX_QUERY_REPLY_BYTES } from "./query-snapshot.ts";

/** Managed RPC children only. IPC is separate from RPC stdout, and never writes
 * query prompts, answers, usage or branch entries into the main SessionManager. */
export default function (pi: ExtensionAPI) {
	const expected = (globalThis as { __piSubagentsGuardExpected?: any }).__piSubagentsGuardExpected;
	if (!expected?.bridgeToken || !process.send) return;
	let context: ExtensionContext | undefined;
	let closed = false;
	const queries = new Map<string, AbortController>();
	const reply = (value: Record<string, unknown>) => {
		if (closed || !process.connected) return;
		const envelope = { channel: "pi-subagent-query", token: expected.bridgeToken, ...value };
		if (Buffer.byteLength(JSON.stringify(envelope), "utf8") > MAX_QUERY_REPLY_BYTES) return;
		try { process.send!(envelope, () => {}); } catch { /* disconnected parent owns cancellation */ }
	};
	const query = async (id: string, question: string, ctx: ExtensionContext) => {
		const controller = new AbortController(); queries.set(id, controller);
		const deadline = setTimeout(() => controller.abort(), 30_000);
		let result: AssistantMessage | undefined; let asOf: unknown; let forbiddenTools = false;
		const model = ctx.model;
		try {
			if (!model || `${model.provider}/${model.id}` !== expected.model || fs.realpathSync(ctx.cwd) !== expected.cwd || ctx.sessionManager.getSessionId() !== expected.id || ctx.isProjectTrusted() !== expected.childTrusted || (expected.thinkingLevel && pi.getThinkingLevel() !== expected.thinkingLevel)) throw new Error("QUERY_CONFIG_CHANGED: child model/trust/identity differs from verified managed configuration");
			const header = ctx.sessionManager.getHeader(); if (!header) throw new Error("QUERY_IDENTITY: missing canonical header");
			// All state is captured synchronously before any provider await. No hooks,
			// resource loader or tool execution enter this disposable model request.
			let snapshot;
			if (expected.readyQuerySnapshot) {
				// Replay the immutable committed copy, not startup hooks' changes to
				// the disposable working copy and never the original managed file.
				const captured = expected.readyQuerySnapshot;
				const file = fs.openSync(captured.path, "r");
				let bytes: Buffer;
				try {
					const buffer = Buffer.alloc(8 * 1024 * 1024 + 1); let length = 0;
					while (length < buffer.length) { const read = fs.readSync(file, buffer, length, buffer.length - length, null); if (!read) break; length += read; }
					bytes = buffer.subarray(0, length);
					if (length > 8 * 1024 * 1024 || createHash("sha256").update(bytes).digest("hex") !== captured.hash) throw new Error("QUERY_CHECKPOINT_CHANGED: committed query copy changed");
				} finally { fs.closeSync(file); }
				const records = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim().split("\n").map(line => JSON.parse(line));
				const savedHeader = records.shift();
				if (savedHeader?.type !== "session" || savedHeader.version !== 3 || savedHeader.id !== expected.id || savedHeader.cwd !== expected.cwd || savedHeader.parentSession !== undefined) throw new Error("QUERY_IDENTITY: committed query header mismatch");
				snapshot = safeSnapshot(savedHeader as SessionHeader, records as SessionEntry[], captured.leafId, ctx.getSystemPrompt());
			} else snapshot = safeSnapshot(header, ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId(), ctx.getSystemPrompt());
			asOf = snapshot.asOf;
			const messages = [...snapshot.messages,
				{ role: "system" as const, content: "This is a disposable read-only query about the captured delegated conversation, not a continuation of its task. Answer only the query using visible evidence. No tools are available; do not emit tool calls. Explain snapshot staleness and do not claim unseen work completed.", toolsAdded: [], timestamp: Date.now() },
				{ role: "user" as const, content: `Snapshot metadata: ${JSON.stringify(asOf)}\nLiteral parent query:\n${question}`, timestamp: Date.now() }];
			const stream = ctx.modelRegistry.streamSimple(model, { messages, tools: [] }, { signal: controller.signal, maxTokens: 2048,
				reasoning: pi.getThinkingLevel() === "off" ? undefined : pi.getThinkingLevel() as Exclude<ThinkingLevel, "off"> });
			let bytes = 0;
			for await (const event of stream) {
				if (event.type === "toolcall_start" || event.type === "toolcall_delta" || event.type === "toolcall_end") {
					forbiddenTools = true; controller.abort();
				}
				if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") { bytes += Buffer.byteLength(event.delta, "utf8"); if (bytes > MAX_INTERACTION_BYTES) controller.abort(); }
			}
			// Keep draining to terminal evidence: abort alone does not prove the
			// provider stopped and must not prematurely release the parent lease.
			result = await stream.result();
			if (forbiddenTools) throw new Error("QUERY_TOOLS_FORBIDDEN: provider streamed a tool call; it was not executed");
			if (controller.signal.aborted || result.stopReason === "aborted") throw new Error("QUERY_ABORTED: query cancelled or exceeded bounded deadline/output");
			if (result.stopReason === "error") throw new Error(result.errorMessage ?? "Query provider failed");
			if (result.content.some(part => part.type === "toolCall")) throw new Error("QUERY_TOOLS_FORBIDDEN: provider emitted a tool call; it was not executed");
			const text = messageText(result.content);
			const output = Buffer.from(text.slice(0, 8192), "utf8").subarray(0, 8192).toString("utf8").replace(/\uFFFD$/u, "");
			reply({ type: "query_result", queryId: id, status: "completed", asOf, output, outputTruncated: Buffer.byteLength(text, "utf8") > 8192, usage: result.usage, provider: model.provider, model: model.id });
		} catch (error) {
			reply({ type: "query_result", queryId: id, status: !forbiddenTools && controller.signal.aborted ? "aborted" : "failed", asOf: asOf ?? null, snapshotUnavailable: !asOf, usage: result?.usage, usageUnknown: !result?.usage, provider: model?.provider, model: model?.id, error: forbiddenTools ? "QUERY_TOOLS_FORBIDDEN: provider streamed a tool call; it was not executed" : error instanceof Error ? error.message.slice(0, 2048) : String(error).slice(0, 2048) });
		} finally { clearTimeout(deadline); queries.delete(id); }
	};
	const receive = (input: unknown) => {
		if (closed || !context || !input || typeof input !== "object") return;
		const value = input as Record<string, unknown>;
		if (value.channel !== "pi-subagent-query" || value.token !== expected.bridgeToken) return;
		if (value.type === "cancel_queries") { for (const controller of queries.values()) controller.abort(); return; }
		if (value.type === "cancel_query" && typeof value.queryId === "string") { queries.get(value.queryId)?.abort(); return; }
		if (value.type !== "query" || typeof value.queryId !== "string") return;
		try {
			validateInteraction(value.message);
			if (queries.size >= 2 || queries.has(value.queryId)) throw new Error("QUERY_CAPACITY: at most two child queries concurrently");
			void query(value.queryId, value.message, context);
		} catch (error) { reply({ type: "query_result", queryId: value.queryId, status: "failed", error: error instanceof Error ? error.message : String(error) }); }
	};
	pi.on("before_agent_start", () => { if (expected.readyQuerySnapshot) throw new Error("QUERY_MAINLINE_FORBIDDEN: disposable ready query cannot prompt or steer the task"); });
	pi.on("session_start", (_event, ctx) => { context = ctx; closed = false; process.on("message", receive); });
	pi.on("session_shutdown", () => {
		closed = true; context = undefined; process.off("message", receive);
		for (const controller of queries.values()) controller.abort();
	});
}
