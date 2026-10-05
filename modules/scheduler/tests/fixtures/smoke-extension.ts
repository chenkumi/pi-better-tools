/** Manual real-Pi smoke fixture. Run only with an isolated PI_AGENT_DIR and report path. */
import { writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import scheduler from "../../dist/extension.js";

export default function (pi: any) {
  if (!process.env.PI_AGENT_DIR || !process.env.PI_SCHEDULER_SMOKE_REPORT) throw new Error("Smoke fixture requires an isolated agent directory and report path");
  globalThis.fetch = async () => { throw new Error("Network forbidden in offline scheduler smoke fixture"); };
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  scheduler({ ...pi,
    registerTool: (tool: any) => { tools.set(tool.name, tool); pi.registerTool(tool); },
    registerCommand: (name: string, command: any) => { commands.set(name, command); pi.registerCommand(name, command); },
  });
  pi.registerProvider("scheduler-fixture", {
    api: "scheduler-fixture-api", baseUrl: "http://unused.invalid", apiKey: "fixture-only-not-a-secret",
    models: [{ id: "offline", name: "Scheduler offline fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 2048,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model: any, context: any) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const last = context.messages.at(-1);
        const isToolPrompt = last?.role === "user" && JSON.stringify(last).includes("SMOKE_STATUS_TOOL");
        const message: any = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: "start", partial: message });
        if (isToolPrompt) {
          message.content.push({ type: "toolCall", id: "fixture-status", name: "schedule_status", arguments: {} });
          message.stopReason = "toolUse";
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
          stream.push({ type: "toolcall_delta", contentIndex: 0, delta: "{}", partial: message });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: message.content[0], partial: message });
        } else {
          const text = `SMOKE_WORK child=${process.env.PI_SCHEDULER_CHILD ?? "0"}`;
          message.content.push({ type: "text", text });
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
          stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
        }
        stream.push({ type: "done", reason: message.stopReason, message }); stream.end();
      });
      return stream;
    },
  });

  pi.registerCommand("scheduler-smoke", {
    description: "Run isolated offline scheduler acceptance",
    async handler(_args: string, ctx: any) {
      const created: string[] = [];
      const observations: any[] = [];
      const call = async (name: string, params: any) => (await tools.get(name).execute("smoke", params, undefined, undefined, ctx)).structuredContent;
      const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
      const wait = async (condition: () => Promise<boolean>, label: string, timeout = 30000) => {
        const start = Date.now(); let progress = 0;
        while (!(await condition())) {
          if (Date.now() - start > timeout) throw new Error(`Timed out: ${label}`);
          if (Date.now() - progress > 3000) { ctx.ui.notify(`Smoke progress: waiting for ${label}`, "info"); progress = Date.now(); }
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      };
      const once = (ms: number) => ({ kind: "once", expression: new Date(Date.now() + ms).toISOString(), timezone: "Asia/Taipei" });
      const create = async (timing: any) => {
        const result = await call("schedule_create", { prompt: "SMOKE_WORK", timing, execution: { provider: "scheduler-fixture", model: "offline" } });
        created.push(result.schedule.id); return result;
      };
      try {
        ctx.ui.notify("Smoke progress: checking real tool discovery", "info");
        check([...tools.keys()].every((name) => pi.getAllTools().some((t: any) => t.name === name)), "Real Pi tool registry missing scheduler tools");
        const initial = await call("schedule_status", {}); check(initial.runtime.role === "host", `Unexpected host role: ${initial.runtime.role}`);
        const sessionJob = await call("schedule_create", { prompt: "SMOKE_WORK", timing: once(1500), mode: "session", execution: { provider: "scheduler-fixture", model: "offline" } });
        created.push(sessionJob.schedule.id);
        await wait(async () => (await call("schedule_status", { id: sessionJob.schedule.id })).runs.some((r: any) => r.status === "succeeded"), "real current-session one-shot");
        observations.push({ case: "session one-shot", run: "succeeded" });
        const cancelled = await create(once(6000));
        await call("schedule_update", { id: cancelled.schedule.id, revision: 1, patch: { prompt: "NEVER_RUN" } });
        await call("schedule_cancel", { id: cancelled.schedule.id });
        const job = await create(once(3000));
        await wait(async () => (await call("schedule_status", { id: job.schedule.id })).runs.some((r: any) => r.status === "succeeded"), "real child one-shot");
        const completed = await call("schedule_status", { id: job.schedule.id });
        check(completed.runs.length === 1 && completed.schedules[0].consumed, "One-shot did not consume exactly once");
        // Inspect the persisted bounded stream prefix for this fixture's child marker.
        const { readFile } = await import("node:fs/promises");
        const output = await readFile(join(process.env.PI_AGENT_DIR!, "pi-scheduler", "logs", `${completed.runs[0].runId}.stdout.log`), "utf8");
        check(output.includes("SMOKE_WORK child=1"), "Independent child did not execute the offline provider");
        observations.push({ case: "one-shot", id: job.schedule.id, run: completed.runs[0].status, childMarker: true });
        const cron = await create({ kind: "cron", expression: "*/2 * * * * *", timezone: "Asia/Taipei" });
        // A cold installed CLI may take >20s; busy skips can evict success from a 10-run page.
        await wait(async () => (await call("schedule_status", { id: cron.schedule.id, runsLimit: 50 })).runs.filter((r: any) => r.status === "succeeded").length >= 2, "two real cron occurrences", 90000);
        await commands.get("schedule").handler(`cancel ${cron.schedule.id}`, ctx);
        const cronStatus = await call("schedule_status", { id: cron.schedule.id, runsLimit: 50 });
        check(cronStatus.schedules[0].state === "cancelled", "Human cancellation command did not persist");
        const count = cronStatus.runs.length;
        await new Promise((resolve) => setTimeout(resolve, 2500));
        check((await call("schedule_status", { id: cron.schedule.id, runsLimit: 50 })).runs.length === count, "Cancelled cron dispatched again");
        check((await call("schedule_status", { id: cancelled.schedule.id })).runs.length === 0, "Cancelled once dispatched");
        observations.push({ case: "cron and human cancel", runs: count, noPostCancelDispatch: true });
        for (const file of ["runner.cmd", "runner-launcher.json"]) {
          let exists = true; try { await access(join(process.env.PI_AGENT_DIR!, "pi-scheduler", file)); } catch { exists = false; }
          check(!exists, `Unexpected OS launcher file: ${file}`);
        }
        await commands.get("schedule").handler("status", ctx);
        await writeFile(process.env.PI_SCHEDULER_SMOKE_REPORT!, JSON.stringify({ result: "PASS", model: "deterministic offline fixture (not external provider)", tools: [...tools.keys()], observations }, null, 2));
        ctx.ui.notify("Scheduler smoke PASS: real Pi tools, once, cron and cancellation; no OS service.", "info");
      } catch (error) {
        await writeFile(process.env.PI_SCHEDULER_SMOKE_REPORT!, JSON.stringify({ result: "FAIL", error: String(error), observations }, null, 2));
        ctx.ui.notify(`Scheduler smoke FAIL: ${error}`, "error");
      } finally {
        for (const id of created) await call("schedule_cancel", { id, cancelRunning: true });
      }
    },
  });
}
