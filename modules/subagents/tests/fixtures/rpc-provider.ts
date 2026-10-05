// Offline real-host RPC fixture. All synchronization is event/file based, not sleeps.
import { existsSync, writeFileSync, watch } from "node:fs";
import { join } from "node:path";
import { createAssistantMessageEventStream, getCurrentTools } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
const text = (message: any) => typeof message?.content === "string" ? message.content : message?.content?.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n") ?? "";
const usage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
export default function (pi: ExtensionAPI) {
	pi.on("input", event => {
		if (event.text.startsWith("[Delegated user control") && event.text.includes("transform-control")) {
			writeFileSync(join(process.cwd(), "control-transformed"), "input hook ran");
			return { action: "transform", text: "transformed canonical delegated instruction" };
		}
		if (event.text.startsWith("[Delegated user control") && event.text.includes("handled-control")) return { action: "handled" };
		return { action: "continue" };
	});
	pi.registerTool({ name: "barrier", label: "Barrier", description: "Offline event gate", parameters: Type.Object({}),
		async execute(_id, _args, signal, _update, ctx) {
			const release = join(ctx.cwd, "release");
			await new Promise<void>((resolve, reject) => {
				const done = (error?: Error) => { observer.close(); signal?.removeEventListener("abort", aborted); error ? reject(error) : resolve(); };
				const aborted = () => done(new Error("barrier aborted"));
				const observer = watch(ctx.cwd, () => { if (existsSync(release)) done(); });
				signal?.addEventListener("abort", aborted, { once: true });
				writeFileSync(join(ctx.cwd, "barrier-ready.json"), JSON.stringify({ leafId: ctx.sessionManager.getLeafId(), sessionFile: ctx.sessionManager.getSessionFile() }));
				if (existsSync(release)) done(); else if (signal?.aborted) aborted();
			});
			return { content: [{ type: "text", text: "barrier released" }], details: {} };
		} });
	pi.registerTool({ name: "forbidden", label: "Forbidden", description: "Must never execute from queries", parameters: Type.Object({}), async execute() {
		writeFileSync(join(process.cwd(), "forbidden-executed"), "unsafe"); return { content: [{ type: "text", text: "unsafe" }], details: {} };
	} });
	pi.registerProvider("subagent-test", { apiKey: "offline-dummy", api: "subagent-test-api", baseUrl: "http://127.0.0.1:1/never-contacted",
		models: [{ id: "fixture", name: "Offline RPC fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 2048 }],
		streamSimple(model, context, options) {
			const stream = createAssistantMessageEventStream();
			const users = context.messages.filter(m => m.role === "user").map(text); const question = users.at(-1) ?? "";
			const query = question.includes("Literal parent query:\n");
			const message: any = { role: "assistant", provider: model.provider, api: model.api, model: model.id, content: [], usage, timestamp: Date.now(), stopReason: "stop" };
			const finish = (error?: string) => { if (error) { message.stopReason = options?.signal?.aborted ? "aborted" : "error"; message.errorMessage = error; stream.push({ type: "error", reason: message.stopReason, error: message }); } else { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason, message }); } stream.end(); };
			setImmediate(() => {
				if (pi.getActiveTools().includes("subagent")) {
					if (!context.messages.some(m => m.role === "toolResult" && m.toolName === "subagent")) { message.content = [{ type: "toolCall", id: "parent-dispatch", name: "subagent", arguments: { agent: "worker", task: "interactive", background: true } }]; message.stopReason = "toolUse"; }
					else message.content = [{ type: "text", text: context.messages.some(m => text(m).includes('"kind":"task_result"')) ? "parent automatic follow-up" : "parent idle" }];
					finish(); return;
				}
				if (query) {
					const capture = { tools: getCurrentTools(context.messages).map(t => t.name), roles: context.messages.map(m => m.role), users,
						opaque: context.messages.flatMap(m => m.role === "assistant" ? m.content.filter(p => p.type === "thinking").map((p: any) => p.thinkingSignature) : []) };
					writeFileSync(join(process.cwd(), "query-capture.json"), JSON.stringify(capture));
					if (question.includes("hold-query")) {
						const abort = () => { writeFileSync(join(process.cwd(), "query-aborted"), "signal reached provider API"); finish("query aborted"); };
						if (options?.signal?.aborted) abort(); else options?.signal?.addEventListener("abort", abort, { once: true }); return;
					}
					if (question.includes("stream-tool")) {
						const abort = () => {
							writeFileSync(join(process.cwd(), "query-tool-aborted"), "aborted on first streamed tool event");
							delete message.usage; finish("streamed tool aborted without terminal usage");
						};
						options?.signal?.addEventListener("abort", abort, { once: true });
						// No terminal response until abort: waiting for a completed tool
						// call instead of its first delta deadlocks this probe.
						stream.push({ type: "toolcall_delta", contentIndex: 0, delta: "{", partial: message }); return;
					}
					if (question.includes("fail-query")) { finish("offline query failure"); return; }
					if (question.includes("emit-tool")) { message.content = [{ type: "toolCall", id: "query-forbidden", name: "forbidden", arguments: {} }]; message.stopReason = "toolUse"; }
					else message.content = [{ type: "text", text: JSON.stringify({ ...capture, answer: "offline query answer" }) }];
					finish(); return;
				}
				const prime = question === "prime" || question.includes("Task: prime\n"); const hasResult = context.messages.some(m => m.role === "toolResult" && m.toolName === "barrier");
				if (!prime && !hasResult) { message.content = [{ type: "thinking", thinking: "private", thinkingSignature: "opaque-main-call" }, { type: "toolCall", id: "main-barrier", name: "barrier", arguments: {} }]; message.stopReason = "toolUse"; }
				else message.content = [{ type: "thinking", thinking: "private", thinkingSignature: "opaque-prime" }, { type: "text", text: prime ? "primed" : "main complete" }];
				finish();
			});
			return stream;
		},
	});
}
