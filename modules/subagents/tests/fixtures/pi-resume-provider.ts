// Fully offline production parent->tool->child->native-resume fixture. No HTTP transport.
import assert from "node:assert/strict";
import { createAssistantMessageEventStream, getCurrentTools } from "@earendil-works/pi-ai";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
const text = (m: any) => typeof m.content === "string" ? m.content : (m.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
const usage = () => ({ input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
export default function (pi: ExtensionAPI) {
	let requests = 0, executions = 0, capture = "";
	const parent = () => pi.getActiveTools().includes("subagent");
	const save = (name: string, value: unknown) => { if (capture) writeFileSync(join(capture, name), JSON.stringify(value, null, 2)); };
	pi.on("session_start", (_e, ctx) => {
		capture = join(ctx.cwd, "capture", `${parent() ? "parent" : "child"}-${process.pid}`); mkdirSync(capture, { recursive: true });
		save("startup.json", { pid: process.pid, argv: process.argv, id: ctx.sessionManager.getSessionId(), file: ctx.sessionManager.getSessionFile(), cwd: ctx.cwd, model: ctx.model, thinking: pi.getThinkingLevel(), trusted: ctx.isProjectTrusted(), active: pi.getActiveTools(), registered: pi.getAllTools().map(t => t.name) });
	});
	pi.registerTool({ name: "resume_nonce", label: "Resume nonce", description: "Creates one private nonce as an actual tool result", parameters: Type.Object({}),
		async execute(_id, _args, _signal, _update, ctx) {
			executions++; const nonce = randomBytes(24).toString("hex"), opaque = randomBytes(16).toString("hex");
			appendFileSync(join(ctx.cwd, "side-effects.jsonl"), JSON.stringify({ pid: process.pid, nonce }) + "\n");
			return { content: [{ type: "text", text: JSON.stringify({ nonce, opaque, active: pi.getActiveTools(), registered: pi.getAllTools().map(t => t.name), callable: ctx.tools.map(t => t.name) }) }, { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }], details: { opaque }, usage: usage() };
		} });
	pi.registerProvider("resume-offline", { baseUrl: "http://127.0.0.1:1/not-contacted", apiKey: "offline-dummy", api: "resume-offline-api",
		models: ["selected", "alternate"].filter(id => !((process.env.P6_MISSING_MODEL === "1" || (process.env.P6_CHILD_ONLY_MISSING === "1" && process.argv.includes("--exclude-tools"))) && id === "selected")).map(id => ({ id, name: `Offline ${id}`, reasoning: true, input: ["text", "image"] as const, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000000, maxTokens: 1000 })),
		streamSimple(model, context, options) {
			const stream = createAssistantMessageEventStream(), nth = ++requests, isParent = parent();
			const message: any = { role: "assistant", provider: model.provider, api: model.api, model: model.id, content: [], stopReason: "pending", usage: usage(), timestamp: Date.now() };
			setImmediate(() => {
				try {
					save(`request-${nth}.json`, { pid: process.pid, model: model.id, reasoning: options?.reasoning, executions, messages: context.messages });
					const currentUser = text(context.messages.filter((m: any) => m.role === "user").at(-1));
					let call: any, output = "parent done";
					if (isParent && nth === 1) {
						if (currentUser.includes("P6_PARENT_DECISION")) {
							const previous = context.messages.filter((m: any) => m.role === "toolResult" && m.toolName === "subagent").at(-1) as any;
							const id = text(previous).match(/Subagent session: ([0-9a-z]{26}) \(ready to resume\)/)?.[1]; assert.ok(id, "visible parent content must supply ready ID");
							call = { name: "subagent", id: "parent-resume", arguments: { resume: id, task: "P6_DECISION_B: Use B and finish the prior work." } };
						} else {
							const task = { agent: "worker", task: "P6_INITIAL_USER: work until a decision is needed.", ...(process.env.P6_CHILD_CWD ? { cwd: process.env.P6_CHILD_CWD } : {}) };
							const mode = process.env.P6_MODE ?? "single";
							const args = mode === "parallel" ? { tasks: [task, task] } : mode === "chain" ? { chain: [task, { ...task, task: "P6_INITIAL_USER: next isolated step {previous}" }] } : { ...task, model: "resume-offline/selected", thinkingLevel: "high" };
							if (process.env.P6_LARGE === "1") (args as any).task = "P6_INITIAL_USER: " + "\u0001".repeat(1024 * 1024);
							call = { name: "subagent", id: "parent-first", arguments: args };
						}
					} else if (!isParent) {
						assert.ok(!getCurrentTools(context.messages).some(t => t.name === "subagent"));
						if (currentUser.includes("P6_DECISION_B")) {
							assert.equal(executions, 0, "No new tool may run before verifying loaded history");
							const old = context.messages.find((m: any) => m.role === "toolResult" && m.toolCallId === "opaque-call") as any;
							assert.ok(old && !old.isError); const value = JSON.parse(text(old)); assert.match(value.nonce, /^[a-f0-9]{48}$/);
							assert.ok(context.messages.some((m: any) => m.role === "user" && text(m).includes("P6_INITIAL_USER")));
							assert.ok(context.messages.some((m: any) => m.role === "assistant" && text(m) === `AWAIT_DECISION:${value.nonce}`));
							assert.ok(context.messages.some((m: any) => m.role === "assistant" && m.content.some((b: any) => b.textSignature === "opaque-signature")));
							assert.ok(!currentUser.includes(value.nonce));
							save("history-before-new-tool.json", { nonce: value.nonce, executions, roles: context.messages.map((m: any) => m.role) }); output = "DECISION_B_COMPLETED";
						} else if (nth === 1) call = { name: "resume_nonce", id: "opaque-call", arguments: { usage: "business data", model: "business model" } };
						else { const old = context.messages.filter((m: any) => m.role === "toolResult").at(-1) as any; output = `AWAIT_DECISION:${JSON.parse(text(old)).nonce}`; }
					}
					stream.push({ type: "start", partial: message });
					if (call) { message.content = [{ type: "toolCall", ...call }]; message.stopReason = "toolUse"; stream.push({ type: "toolcall_start", contentIndex: 0, partial: message }); stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: message.content[0], partial: message }); }
					else { message.content = [{ type: "thinking", thinking: "private fixture reasoning", thinkingSignature: "opaque-thinking" }, { type: "text", text: output, textSignature: "opaque-signature" }]; message.stopReason = "stop"; stream.push({ type: "text_start", contentIndex: 1, partial: message }); stream.push({ type: "text_end", contentIndex: 1, content: output, partial: message }); }
					stream.push({ type: "done", reason: message.stopReason, message }); stream.end();
				} catch (e) { message.stopReason = "error"; message.errorMessage = String(e); stream.push({ type: "error", reason: "error", error: message }); stream.end(); }
			}); return stream;
		} });
}
