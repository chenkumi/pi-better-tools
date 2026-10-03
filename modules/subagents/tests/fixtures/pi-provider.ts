// Offline CLI contract fixture: no HTTP requests, real credentials or paid models.
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const usage = (cost: number) => ({ input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12,
	cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } });

export default function (pi: ExtensionAPI) {
	const scenario = process.env.PI_SUBAGENTS_TEST_SCENARIO ?? "normal";
	let attempt = 0;
	let continued = false;
	const isParent = () => pi.getActiveTools().includes("subagent");
	pi.on("agent_before_settle", () => {
		if (scenario === "follow-up" && !isParent() && !continued) {
			continued = true;
			// A stop response is not runnable context on its own. Supply the
			// actionable boundary's context message before requesting continuation.
			return { entries: [{ type: "custom_message" as const, customType: "fixture-follow-up", content: "Continue this offline fixture.", display: false }], continue: true };
		}
	});
	pi.registerTool({
		name: "metered_nested", label: "Nested metered fixture", description: "Offline nested usage", parameters: Type.Object({}),
		async execute() { return { content: [{ type: "text", text: "nested result" }], details: {}, usage: usage(2) }; },
	});
	pi.registerTool({
		name: "metered", label: "Metered fixture", description: "Offline usage fixture", parameters: Type.Object({}),
		async execute(_id, _args, _signal, _update, ctx) {
			if (scenario === "nested-usage") await ctx.executeTool("metered_nested", {});
			return { content: [{ type: "text", text: "metered result" }], details: {}, usage: usage(scenario === "nested-usage" ? 1 : 3) };
		},
	});
	pi.registerTool({
		name: "probe", label: "Registry probe", description: "Reports excluded child tools", parameters: Type.Object({}),
		async execute(_id, _args, _signal, _update, ctx) {
			return { content: [{ type: "text", text: JSON.stringify({ active: pi.getActiveTools(), registered: pi.getAllTools().map((tool) => tool.name), callable: ctx.tools.map((tool) => tool.name) }) }], details: {} };
		},
	});
	pi.registerProvider("subagent-test", {
		baseUrl: "http://127.0.0.1:1/never-contacted", apiKey: "offline-test-dummy", api: "subagent-test-api",
		models: [{ id: "fixture", name: "Offline subagent fixture", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 1000 }],
		streamSimple(model, context) {
			const stream = createAssistantMessageEventStream();
			const nth = ++attempt;
			const parent = isParent();
			const message: any = { role: "assistant", provider: model.provider, api: model.api, model: model.id,
				content: [], stopReason: "pending", usage: usage(1), timestamp: Date.now() };
			setImmediate(() => {
				try {
					if (!parent && (scenario === "retry-exhausted" || (scenario === "retry" && nth === 1))) {
						message.stopReason = "error";
						message.errorMessage = "529 overloaded: offline transient fixture";
						stream.push({ type: "error", reason: "error", error: message }); stream.end(); return;
					}
					stream.push({ type: "start", partial: message });
					let call: any;
					if (!parent && nth === 1) {
						if (["usage", "nested-usage"].includes(scenario)) call = { id: "fixture-call", name: "metered", arguments: {} };
						if (scenario === "large-shell") {
							// Exercise the real host shell on every platform, not a stub or skip.
							const windows = process.platform === "win32";
							// A 600 KiB prefix plus a small 2000-line tail separates structured
							// payload retention from Pi's model-facing line truncation.
							const command = windows ? "Write-Output ('x' * 614400); 1..2000 | ForEach-Object { Write-Output '.' }"
								: `'${process.execPath.replace(/'/g, `'"'"'`)}' -e 'process.stdout.write("x".repeat(614400) + "\\n" + ".\\n".repeat(2000))'`;
							call = { id: "fixture-call", name: windows ? "powershell" : "bash", arguments: { command, timeout: 10 } };
						}
						if (scenario === "exclusion") call = { id: "fixture-call", name: "probe", arguments: {} };
					}
					if (parent && nth === 1) {
						const task = { agent: "worker", task: "Offline subagent contract fixture; no paid model calls." };
						const mode = process.env.PI_SUBAGENTS_TEST_MODE ?? "single";
						const args = mode === "parallel" ? { tasks: [task, task] } : mode === "chain" ? { chain: [task, { ...task, task: "Offline next step: {previous}" }] } : task;
						if (scenario === "selection-model-fallback") Object.assign(args, { model: "chat-5.6-terra", thinkingLevel: "high" });
						if (scenario === "selection-thinking-fallback") Object.assign(args, { thinkingLevel: "ultra" });
						if (scenario === "selection-unsupported-thinking") Object.assign(args, { thinkingLevel: "max" });
						if (scenario === "selection-valid-model") Object.assign(args, { provider: "subagent-test", model: "fixture", thinkingLevel: "ultra" });
						if (scenario === "selection-valid-thinking") Object.assign(args, { thinkingLevel: "off" });
						call = { id: "fixture-delegate", name: "subagent", arguments: args };
					}
					if (call) {
						message.content = [{ type: "toolCall", ...call }];
						stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
						stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: message.content[0], partial: message });
						message.stopReason = "toolUse";
					} else {
						const priorTool = [...context.messages].reverse().find((item: any) => item.role === "toolResult") as any;
						const text = parent ? "parent done" : scenario === "retry" ? "recovered-success" : scenario === "follow-up" ? (nth === 1 ? "first answer" : "follow-up answer") : scenario === "exclusion" ? priorTool?.content?.[0]?.text ?? "missing probe" : "done";
						message.content = [{ type: "text", text }];
						stream.push({ type: "text_start", contentIndex: 0, partial: message });
						stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
						stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
						message.stopReason = "stop";
					}
					stream.push({ type: "done", reason: message.stopReason, message }); stream.end();
				} catch (error) {
					message.stopReason = "error"; message.errorMessage = String(error);
					stream.push({ type: "error", reason: "error", error: message }); stream.end();
				}
			});
			return stream;
		},
	});
}
