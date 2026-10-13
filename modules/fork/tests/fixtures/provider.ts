// Deterministic offline provider shared by the parent Pi and its Fork child. No network, no credentials.
// FORK_SCENARIO: basic | nested-shell (child starts a background shell job, then settles early) | gated (child waits for <capture>/release).
import { existsSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAssistantMessageEventStream, getCurrentTools } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const text = (m: any) => typeof m.content === "string" ? m.content : (m.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");

export default function (pi: ExtensionAPI) {
	const dir = process.env.FORK_CAPTURE!;
	const scenario = process.env.FORK_SCENARIO ?? "basic";
	let n = 0;
	pi.registerProvider("fork-offline", {
		baseUrl: "http://127.0.0.1:1/never-contacted", apiKey: "offline-dummy", api: "fork-offline-api",
		models: [{ id: "m", name: "Fork offline", reasoning: true, input: ["text"] as const, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 1000 }],
		streamSimple(model, context, options) {
			const stream = createAssistantMessageEventStream();
			const nth = ++n;
			const message: any = { role: "assistant", provider: model.provider, api: model.api, model: model.id, content: [], stopReason: "stop", timestamp: Date.now(),
				usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			const users = context.messages.filter((m: any) => m.role === "user");
			const lastUser = users.length ? text(users.at(-1)) : "";
			const isChild = users.some((m: any) => text(m).startsWith("You are a Fork:"));
			const last = context.messages.at(-1) as any;
			const wantsFork = last?.role === "user" && lastUser.includes("DO_FORK");
			const everything = JSON.stringify(context.messages);
			const tools = getCurrentTools(context.messages).map(t => t.name);
			const respond = () => {
				stream.push({ type: "start", partial: message });
				if (wantsFork) {
					message.content = [{ type: "toolCall", id: "fork-call-1", name: "fork", arguments: { task: "FORK_TASK_MARKER do the thing", title: "offline fork" } }];
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: message.content[0], partial: message });
					message.stopReason = "toolUse";
				} else if (scenario === "nested-shell" && isChild && !everything.includes("nested-bash-1")) {
					message.content = [{ type: "toolCall", id: "nested-bash-1", name: "bash", arguments: { command: "node nested-job.mjs", background: true } }];
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: message.content[0], partial: message });
					message.stopReason = "toolUse";
				} else {
					const shellDone = /Shell background jobs have finished/.test(everything);
					const out = isChild ? (scenario === "nested-shell" ? (shellDone ? "NESTED_JOB_OBSERVED" : "FORK_CHILD_SETTLED_EARLY") : "FORK_CHILD_DONE") : "PARENT_ACK";
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
				if (scenario !== "gated" || !isChild || wantsFork || existsSync(gate)) { respond(); return; }
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
