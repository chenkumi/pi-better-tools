import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const scenario = process.argv[2];
const taskPath = process.argv.find((arg) => arg.startsWith("@"))?.slice(1);
const task = readFileSync(taskPath, "utf8");
// Protocol tests mock storage, but exercise the mandatory managed wire header.
const guard = JSON.parse(process.env.PI_SUBAGENTS_GUARD);
console.log(JSON.stringify({ type: "session", version: 3, id: guard.id, cwd: guard.cwd }));
const message = (text, stopReason = "stop") => JSON.stringify({
	type: "message_end",
	message: { role: "assistant", content: [{ type: "text", text }], stopReason },
});

const emit = (event) => new Promise((resolve, reject) => process.stdout.write(`${JSON.stringify(event)}\n`, (error) => error ? reject(error) : resolve()));
const usage = (cost = 1) => ({ input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { total: cost } });
const assistant = (text, stopReason = "stop", errorMessage) => ({ type: "message_end", message: {
	role: "assistant", content: text ? [{ type: "text", text }] : [], stopReason, errorMessage, usage: usage(),
} });
const settled = { type: "agent_settled" };

switch (scenario) {
	case "retry-success":
	case "retry-heartbeat":
	case "retry-exhausted":
	case "length-recovery": {
		await emit(assistant(scenario === "length-recovery" ? "partial" : "", scenario === "length-recovery" ? "length" : "error", "transient failure"));
		await emit({ type: "agent_end", willRetry: true, messages: [] });
		await emit({ type: "auto_retry_start", attempt: 1, delayMs: 1 });
		if (scenario === "retry-heartbeat") for (let index = 0; index < 6; index++) {
			process.stderr.write("retry heartbeat");
			await delay(100);
		}
		await emit({ type: "agent_start" });
		await emit({ type: "message_start", message: { role: "assistant", content: [] } });
		await emit(assistant(scenario === "retry-exhausted" ? "" : "recovered-success", scenario === "retry-exhausted" ? "error" : "stop", scenario === "retry-exhausted" ? "retry exhausted" : undefined));
		await emit({ type: "auto_retry_end", success: scenario !== "retry-exhausted" });
		await emit(settled);
		break;
	}
	case "follow-up":
	case "incomplete-continuation":
	case "incomplete-message": {
		await emit(assistant("first answer"));
		await emit({ type: "agent_end", willRetry: false, messages: [] });
		await emit({ type: "agent_start" });
		await emit({ type: "message_start", message: { role: "assistant", content: [] } });
		if (scenario !== "incomplete-message") await emit(assistant("follow-up answer", scenario === "incomplete-continuation" ? "toolUse" : "stop"));
		if (scenario === "follow-up") await emit(settled);
		break;
	}
	case "malformed-before-settled":
		await emit(assistant("done"));
		process.stdout.write("malformed before settlement\n");
		break;
	case "settled-tail":
		await emit(assistant("done"));
		await emit(settled);
		process.stdout.write("not JSON".repeat(1024 * 1024 + 1));
		break;
	case "settled-without-assistant":
		await emit(settled);
		await emit(assistant("not part of the settled run"));
		break;
	case "structured-shell":
	case "escaped-structured-shell":
	case "large-image": {
		const content = scenario === "large-image" ? [{ type: "image", data: "AAAA".repeat(512 * 1024), mimeType: "image/png" }] : [{ type: "text", text: "truncated summary" }];
		const structuredContent = scenario === "large-image" ? undefined : { output: (scenario === "escaped-structured-shell" ? "\u0001" : "x").repeat(1024 * 1024) };
		await emit({ type: "tool_execution_end", toolCallId: "large-call", toolName: "powershell", isError: false, result: { content, structuredContent } });
		await emit({ type: "message_end", message: { role: "toolResult", toolCallId: "large-call", toolName: "powershell", content, isError: false } });
		await emit(assistant("done"));
		await emit(settled);
		break;
	}
	case "tool-usage": {
		await emit(assistant("before tool", "toolUse"));
		await emit({ type: "tool_execution_end", parentToolCallId: "root", toolCallId: "root/1", toolName: "nested", isError: false, result: { content: [{ type: "text", text: "nested result" }], usage: usage(2) } });
		const result = { role: "toolResult", toolCallId: "root", toolName: "metered", isError: false, content: [{ type: "text", text: "root result" }], usage: usage(3) };
		await emit({ type: "tool_execution_end", toolCallId: "root", toolName: "metered", isError: false, result });
		await emit({ type: "message_end", message: result });
		await emit({ type: "tool_result_end", message: result });
		await emit({ type: "message_end", message: result });
		await emit(assistant("done"));
		await emit(settled);
		break;
	}
	case "empty": break;
	case "header": break; // valid managed header was already emitted
	case "toolUse": console.log(message("still working", "toolUse")); break;
	case "missing-content": console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop" } })); break;
	case "invalid-content": console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [null], stopReason: "stop" } })); break;
	case "malformed": console.log("not JSON"); break;
	case "oversized": process.stdout.write("x".repeat(8 * 1024 * 1024 + 1)); break;
	case "error": console.log(message("provider failed", "error")); break;
	case "aborted": console.log(message("provider aborted", "aborted")); break;
	case "normal": process.stdout.write(message("done")); break; // valid EOF without newline
	case "large-review-stream": {
		// Each record fits the parser bound, but total traffic and logged results exceed 2 MiB.
		const content = [{ type: "text", text: "x".repeat(64 * 1024) }];
		for (let index = 0; index < 40; index++) {
			const result = { role: "toolResult", toolCallId: `review-${index}`, toolName: "read", isError: false, content };
			const events = [
				{ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "y".repeat(64 * 1024) } },
				{ type: "tool_execution_end", toolCallId: result.toolCallId, toolName: "read", isError: false, result: { content } },
				{ type: "message_start", message: result },
				{ type: "message_end", message: result },
				{ type: "turn_end", toolResults: [result] },
			];
			for (const event of events) {
				await new Promise((resolve, reject) => process.stdout.write(`${JSON.stringify(event)}\n`, (error) => error ? reject(error) : resolve()));
			}
			await delay(10); // Permit the real JSONL writer to drain between turns.
		}
		console.log(message("review complete"));
		break;
	}
	case "stress-immediate":
	case "stress-delayed":
	case "stress-missing": {
		const emit = (event) => new Promise((resolve, reject) => process.stdout.write(`${JSON.stringify(event)}\n`, (error) => error ? reject(error) : resolve()));
		const content = (canonical) => [{ type: "text", text: (canonical ? "C" : "F").repeat(256 * 1024) }];
		const canonical = (index) => ({ type: "message_end", message: { role: "toolResult", toolCallId: `stress-${index}`, toolName: "read", isError: false, content: content(true) } });
		for (let index = 0; index < 400; index++) {
			await emit({ type: "tool_execution_end", toolCallId: `stress-${index}`, toolName: "read", isError: false, result: { content: content(false) } });
			if (scenario === "stress-immediate") { await emit(canonical(index)); await emit(canonical(index)); }
			await new Promise((resolve, reject) => process.stderr.write("e".repeat(2048), (error) => error ? reject(error) : resolve()));
		}
		if (scenario === "stress-delayed") for (let index = 0; index < 400; index++) { await emit(canonical(index)); await emit(canonical(index)); }
		await emit(JSON.parse(message("stress complete")));
		break;
	}
	case "large-pending-results":
		for (let index = 0; index < 9; index++) {
			console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: `pending-${index}`, toolName: "read", isError: false, result: { content: [{ type: "text", text: "x".repeat(256 * 1024) }] } }));
			await delay(10);
		}
		console.log(message("done"));
		break;
	case "large-retained-output":
		for (let index = 0; index < 9; index++) {
			console.log(message("x".repeat(256 * 1024), "toolUse"));
			await delay(10);
		}
		console.log(message("done"));
		break;
	case "stream":
		console.log(JSON.stringify({ type: "message_start", message: { role: "assistant", content: [] } }));
		console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } }));
		console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "considering" } }));
		console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "considering" } }));
		console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 1 } }));
		console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "working" } }));
		console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 1, content: "working" } }));
		console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 2, id: "call-1", toolName: "search" } }));
		console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 2, delta: "q" } }));
		console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 2, toolCall: { id: "call-1", name: "search", arguments: { q: "pi" } } } }));
		console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 3, id: "call-2", toolName: "read" } }));
		console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 3, toolCall: { id: "call-2", name: "read", arguments: { path: "README.md" } } } }));
		console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [
			{ type: "text", text: "working" },
			{ type: "toolCall", id: "call-1", name: "search", arguments: { q: "pi" } },
			{ type: "toolCall", id: "call-2", name: "read", arguments: { path: "README.md" } },
		], stopReason: "toolUse" } }));
		console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "call-1", toolName: "search", args: { q: "pi" } }));
		console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "call-2", toolName: "read", args: { path: "README.md" } }));
		console.log(JSON.stringify({ type: "tool_execution_update", toolCallId: "call-1", toolName: "search", partialResult: { content: [{ type: "text", text: "searching" }] } }));
		console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "call-2", toolName: "read", isError: false, result: { content: [{ type: "text", text: "provisional read" }] } }));
		console.log(JSON.stringify({ type: "message_end", message: { role: "toolResult", toolCallId: "call-2", toolName: "read", isError: false, content: [{ type: "text", text: "found" }] } }));
		console.log(JSON.stringify({ type: "tool_execution_update", toolCallId: "call-1", toolName: "search", partialResult: { content: [{ type: "text", text: "still searching" }] } }));
		console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "call-1", toolName: "search", isError: false, result: { content: [{ type: "text", text: "found" }] } }));
		console.log(JSON.stringify({ type: "message_end", message: { role: "toolResult", toolCallId: "call-1", toolName: "search", isError: false, content: [{ type: "text", text: "found" }] } }));
		console.log(message("done", "stop"));
		break;
	case "tool-fallback":
		console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "fallback-call", toolName: "fallback", isError: false, result: { content: [{ type: "text", text: "fallback result" }] } }));
		console.log(message("done", "stop"));
		break;
	case "echo": console.log(message(task)); break;
	case "unicode":
		for (const byte of Buffer.from(message("中文🙂𠮷"))) {
			process.stdout.write(Buffer.from([byte]));
			await delay(2);
		}
		for (const byte of Buffer.from("診斷🙂")) {
			process.stderr.write(Buffer.from([byte]));
			await delay(2);
		}
		break;
	case "raw-stdout-heartbeat":
	case "raw-stderr-heartbeat": {
		const output = scenario === "raw-stdout-heartbeat" ? process.stdout : process.stderr;
		const parts = message("🙂").split("🙂");
		if (output === process.stdout) output.write(parts[0]);
		for (const byte of Buffer.from("🙂")) {
			output.write(Buffer.from([byte]));
			await delay(100);
		}
		if (output === process.stdout) output.write(parts[1]);
		else console.log(message("done"));
		break;
	}
	case "silent":
		setInterval(() => {}, 1000);
		break;
	case "stdout-heartbeat":
		for (let index = 0; index < 5; index++) {
			process.stdout.write(" ");
			await delay(100);
		}
		console.log(message("done"));
		break;
	case "stderr-heartbeat":
		for (let index = 0; index < 5; index++) {
			process.stderr.write("heartbeat");
			await delay(100);
		}
		console.log(message("done"));
		break;
	case "heartbeat-stop":
		for (let index = 0; index < 3; index++) {
			process.stdout.write(" ");
			await delay(100);
		}
		setInterval(() => {}, 1000);
		break;
	case "terminal-hang":
		console.log(message("done"));
		console.log(JSON.stringify(settled));
		setInterval(() => {}, 1000);
		break;
	case "cancel":
		process.on("SIGTERM", () => {});
		setInterval(() => {}, 1000);
		console.log(message("ready to cancel", "toolUse"));
		break;
	default: throw new Error(`Unknown scenario: ${scenario}`);
}
