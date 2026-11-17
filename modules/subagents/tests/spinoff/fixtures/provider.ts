// Deterministic offline provider shared by the parent Pi and its Spinoff child. No network, no credentials.
// SPINOFF_SCENARIO: basic | nested-shell (child starts a background shell job, then settles early) | gated (child waits for <capture>/release)
//  | interrupted (child starts a long background job, then its own model call is interrupted mid-stream).
import { existsSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAssistantMessageEventStream, getCurrentTools } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Marks the long background job so repeated child turns can tell whether it already started. */
export const INTERRUPTED_MARKER = "SPINOFF_INTERRUPTED_JOB";

const text = (m: any) => typeof m.content === "string" ? m.content : (m.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");

export default function (pi: ExtensionAPI) {
	const dir = process.env.SPINOFF_CAPTURE!;
	const scenario = process.env.SPINOFF_SCENARIO ?? "basic";
	let n = 0;
	pi.registerProvider("spinoff-offline", {
		baseUrl: "http://127.0.0.1:1/never-contacted", apiKey: "offline-dummy", api: "spinoff-offline-api",
		models: [{ id: "m", name: "Spinoff offline", reasoning: true, input: ["text"] as const, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 1000 }],
		streamSimple(model, context, options) {
			const stream = createAssistantMessageEventStream();
			const nth = ++n;
			const message: any = { role: "assistant", provider: model.provider, api: model.api, model: model.id, content: [], stopReason: "stop", timestamp: Date.now(),
				usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			const users = context.messages.filter((m: any) => m.role === "user");
			const lastUser = users.length ? text(users.at(-1)) : "";
			const isChild = users.some((m: any) => text(m).startsWith("You are the background Spinoff."));
			const last = context.messages.at(-1) as any;
			const wantsSpinoff = last?.role === "user" && lastUser.includes("DO_SPINOFF");
			const everything = JSON.stringify(context.messages);
			const tools = getCurrentTools(context.messages).map(t => t.name);
			const respond = () => {
				stream.push({ type: "start", partial: message });
				if (wantsSpinoff) {
					message.content = [{ type: "toolCall", id: "spinoff-call-1", name: "spinoff", arguments: { task: "SPINOFF_TASK_MARKER do the thing", title: "offline spinoff" } }];
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: message.content[0], partial: message });
					message.stopReason = "toolUse";
				} else if (!isChild && last?.role === "user" && lastUser.includes("CHECK_STATUS")) {
					// Lets a test read exactly what agent_status would tell the user.
					message.content = [{ type: "toolCall", id: "status-call-1", name: "agent_status", arguments: {} }];
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: message.content[0], partial: message });
					message.stopReason = "toolUse";
				} else if (!isChild && last?.role === "user" && lastUser.includes("MESSAGE_SPINOFF")) {
					// Lets a test inject one message into the live Spinoff it just created.
					const jobId = lastUser.match(/[0-9A-HJKMNP-TV-Z]{26}/)?.[0] ?? "";
					message.content = [{ type: "toolCall", id: "message-call-1", name: "agent_message", arguments: { jobId, message: "FOLLOWUP please finish the extra item" } }];
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: message.content[0], partial: message });
					message.stopReason = "toolUse";
				} else if (isChild && lastUser.includes("FOLLOWUP please")) {
					// The injected message arrived as the child's own user message: answer it, then settle.
					message.content = [{ type: "text", text: "SPINOFF_CHILD_FOLLOWUP" }];
					stream.push({ type: "text_start", contentIndex: 0, partial: message });
					stream.push({ type: "text_delta", contentIndex: 0, delta: "SPINOFF_CHILD_FOLLOWUP", partial: message });
					stream.push({ type: "text_end", contentIndex: 0, content: "SPINOFF_CHILD_FOLLOWUP", partial: message });
				} else if (scenario === "interrupted" && isChild) {
					if (!everything.includes(INTERRUPTED_MARKER)) {
						message.content = [{ type: "toolCall", id: "interrupted-job-1", name: "bash", arguments: { command: `node blocked-job.mjs # ${INTERRUPTED_MARKER}`, background: true } }];
						stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
						stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: message.content[0], partial: message });
						message.stopReason = "toolUse";
					} else {
						// The child's own model call is cut off mid-stream, exactly like the reported quota failure.
						const partial = "Starting the assigned work";
						message.content = [{ type: "text", text: partial }];
						stream.push({ type: "text_start", contentIndex: 0, partial: message });
						stream.push({ type: "text_delta", contentIndex: 0, delta: partial, partial: message });
						stream.push({ type: "text_end", contentIndex: 0, content: partial, partial: message });
						stream.push({ type: "error", reason: "error", error: { ...message, content: [], stopReason: "error", errorMessage: "The user has reached their subscription usage limit" } });
						stream.end();
						return;
					}
				} else if (scenario === "nested-shell" && isChild && !everything.includes("nested-bash-1")) {
					message.content = [{ type: "toolCall", id: "nested-bash-1", name: "bash", arguments: { command: "node nested-job.mjs", background: true } }];
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: message.content[0], partial: message });
					message.stopReason = "toolUse";
				} else {
					const shellDone = /Shell background jobs have finished/.test(everything);
					const out = isChild ? (scenario === "nested-shell" ? (shellDone ? "NESTED_JOB_OBSERVED" : "SPINOFF_CHILD_SETTLED_EARLY") : "SPINOFF_CHILD_DONE") : "PARENT_ACK";
					message.content = [{ type: "text", text: out }];
					stream.push({ type: "text_start", contentIndex: 0, partial: message });
					stream.push({ type: "text_delta", contentIndex: 0, delta: out, partial: message });
					stream.push({ type: "text_end", contentIndex: 0, content: out, partial: message });
				}
				stream.push({ type: "done", reason: message.stopReason, message });
				stream.end();
			};
			setImmediate(() => {
				writeFileSync(join(dir, `${isChild ? "child" : "parent"}-request-${process.pid}-${nth}.json`), JSON.stringify({ pid: process.pid, nth, isChild, tools, roles: context.messages.map((m: any) => m.role), messages: context.messages }));
				const gate = join(dir, "release");
				if (scenario !== "gated" || !isChild || wantsSpinoff || existsSync(gate)) { respond(); return; }
				// Event-driven gate (no polling): wait for the release file or for the provider request to be aborted.
				const watcher = watch(dir, () => { if (existsSync(gate)) { watcher.close(); respond(); } });
				if (existsSync(gate)) { watcher.close(); respond(); return; } // the file may have appeared before the OS watch was armed
				options?.signal?.addEventListener("abort", () => {
					watcher.close();
					stream.push({ type: "error", reason: "aborted", error: { ...message, stopReason: "aborted", errorMessage: "aborted" } });
					stream.end();
				}, { once: true });
			});
			return stream;
		},
	});
}
