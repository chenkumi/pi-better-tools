import { appendFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Test-only observer: keeps real TUI notifications/rendering and supplies scripted, non-billed model streams. */
export default function tuiObserver(pi: ExtensionAPI, extraScripts: Record<string, any[]> = {}): void {
  const record = (value: unknown) => appendFileSync(process.env.FILE_AUDIT_AB_JOURNAL!, JSON.stringify(value) + "\n");
  let requests = 0, scenario = "", step = 0;
  let tui: any;
  globalThis.fetch = async () => { record({ event: "network-attempt" }); throw new Error("Offline A/B fixture forbids network"); };
  const scripts: Record<string, any[]> = {
    AB_BASELINE: [
      { name: "read", args: { path: "seed.txt" } },
      { name: "read", args: { path: "control.txt" } },
      { name: "edit", args: { path: "seed.txt", edits: [{ oldText: "before", newText: "after" }] } },
      { name: "note", args: { type: "task", content: "# A/B note\n\nDeterministic fixture body." } },
      { name: "read", args: { path: "missing.txt" } },
    ],
    AB_AFTER_CHECK: [],
    AB_CAPACITY: ["alpha", "beta", "gamma"].map(name => ({ name: "write", args: { path: `${name}.txt`, content: name } })),
    AB_NOOP: [],
    ...extraScripts,
  };
  pi.registerProvider("audit-ab-offline", {
    api: "openai-responses", apiKey: "offline-non-secret", baseUrl: "https://unused.invalid",
    models: [{ id: "fixture", name: "Audit A/B offline", reasoning: false, input: ["text"], contextWindow: 128000,
      maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context, options) {
      const user = [...context.messages].reverse().find(message => message.role === "user") as any;
      const text = typeof user?.content === "string" ? user.content : (user?.content ?? []).filter((x: any) => x.type === "text").map((x: any) => x.text).join(" ");
      const name = Object.keys(scripts).find(key => text.trim() === key);
      if (!name) throw new Error("Unexpected A/B prompt");
      if (name !== scenario) { scenario = name; step = 0; }
      const operation = scripts[name][step++];
      const content: any[] = operation
        ? [{ type: "toolCall", id: `${scenario}-${step}`, name: operation.name, arguments: operation.args }]
        : [{ type: "text", text: `${scenario}_DONE` }];
      const message: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content,
        stopReason: operation ? "toolUse" : "stop",
        // Synthetic usage is intentionally zero and is NEVER used for token overhead statistics.
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        try {
          if (options?.signal?.aborted) throw new Error("A/B request aborted");
          // Pi 1.4.0 embeds prompt/tool deltas in system messages. Preserve the full
          // transcript as evidence, but tokenize this explicit semantic projection
          // once, without double-counting system sections or UI-only result details.
          const payload = { systemPrompt: getCurrentSystemPrompt(context.messages), tools: getCurrentTools(context.messages),
            messages: context.messages.filter(item => item.role !== "system").map((item: any) => ({
              role: item.role, content: item.content,
              ...(item.role === "toolResult" ? { toolCallId: item.toolCallId, toolName: item.toolName, isError: item.isError } : {}),
            })) };
          const replacement = await options?.onPayload?.(payload, model);
          record({ event: "request", nth: ++requests, scenario, payload: replacement ?? payload, transcript: context.messages });
          stream.push({ type: "start", partial: message });
        for (const [i, block] of content.entries()) {
          if (block.type === "toolCall") {
            stream.push({ type: "toolcall_start", contentIndex: i, partial: message });
            stream.push({ type: "toolcall_end", contentIndex: i, toolCall: block, partial: message });
          } else {
            stream.push({ type: "text_start", contentIndex: i, partial: message });
            stream.push({ type: "text_end", contentIndex: i, content: block.text, partial: message });
          }
        }
          stream.push({ type: "done", reason: message.stopReason, message }); stream.end();
        } catch (error) {
          message.stopReason = options?.signal?.aborted ? "aborted" : "error";
          message.errorMessage = String(error);
          stream.push({ type: "error", reason: message.stopReason, error: message }); stream.end();
        }
      });
      return stream;
    },
  });
  pi.on("session_start", (_event, ctx) => {
    const notify = ctx.ui.notify.bind(ctx.ui);
    ctx.ui.notify = (message, level) => {
      notify(message, level);
      record({ event: "notification", message, level, requests });
    };
    ctx.ui.setWidget("file-audit-ab-observer", runtime => {
      tui = runtime;
      return { render: () => [], invalidate() {} };
    });
    record({ event: "ready", auditLoaded: pi.getCommands().some(command => command.name === "file-audit"), mode: ctx.mode });
  });
  pi.on("agent_settled", event => { record({ event: "settled", scenario, requests, aborted: event.aborted }); });
  pi.registerCommand("ab-observe", {
    description: "Test-only real terminal snapshot and request-count barrier.",
    handler: async (label, ctx) => {
      if (!tui || ctx.mode !== "tui") throw new Error("A/B fixture requires the actual TUI");
      tui.renderNow(true);
      const lines = tui.render(tui.terminal.columns).map((line: string) => stripVTControlCharacters(line));
      record({ event: "snapshot", label: label.trim(), requests, lines: lines.slice(-500),
        screenLines: tui.getScreenLines?.().map((line: string) => stripVTControlCharacters(line)),
        columns: tui.terminal.columns, rows: tui.terminal.rows, mode: tui.mode });
    },
  });
  pi.on("session_shutdown", () => { record({ event: "shutdown", requests }); });
}
