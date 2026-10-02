import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

/** CLI regression fixture; requires a test-created agent directory. Never use real providers. */
export default function offlineProvider(pi: ExtensionAPI): void {
  if (!process.env.PI_AGENT_DIR?.includes("pi-scheduler-cli-test-")) throw new Error("CLI fixture requires an isolated test directory");
  globalThis.fetch = async () => { throw new Error("Network forbidden in offline CLI regression fixture"); };
  pi.registerProvider("scheduler-cli-test", {
    api: "scheduler-cli-test", apiKey: "offline-non-secret", baseUrl: "http://unused.invalid",
    models: [{ id: "offline", name: "Offline CLI test", reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 2048,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const user = context.messages.filter((message) => message.role === "user").at(-1);
        const text = typeof user?.content === "string" ? user.content : user?.content.filter((block) => block.type === "text").map((block) => block.text).join("\n") ?? "";
        const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [{ type: "text", text: `LITERAL:${text}` }],
          stopReason: "stop", timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as import("@earendil-works/pi-ai").AssistantMessage;
        stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: "stop", message }); stream.end();
      });
      return stream;
    },
  });
}
