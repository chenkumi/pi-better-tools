import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GoalController } from "../src/controller.ts";
import { GoalArgumentsSchema } from "../src/state.ts";
import { filterControls } from "../src/prompts.ts";
import { goalRenderers } from "../src/renderers.ts";

export default function goalExtension(pi: ExtensionAPI) {
  // Managed children cannot own or mutate the parent's goal. Do not even expose
  // the command or tool; inherited control messages are removed from model context.
  if (process.env.PI_SUBAGENTS_GUARD !== undefined || process.env.PI_SCHEDULER_CHILD !== undefined) {
    pi.on("context", event => ({ messages: filterControls(event.messages, null) }));
    return;
  }
  const controller = new GoalController(pi);
  pi.registerCommand("goal", { description: "建立驗收目標並持續推動；status／pause／resume／clear（與 plan 分離）", handler: (args, ctx) => controller.command(args, ctx) });
  pi.registerTool({
    name: "goal", label: "Goal", exposure: "model-only", executionMode: "sequential",
    description: "Read the session acceptance objective with get. For the currently running goal only, submit complete with goalId/runId, summary and verification [{criterion,evidence}], or blocked with reason and suggestedAction. A plan is optional and independent: finishing a plan does not complete a goal. The user owns creation, replacement, pause, resume and clear. Never claim skipped or unexecuted required verification passed.",
    parameters: GoalArgumentsSchema,
    ...goalRenderers,
    async execute(_id, args, signal, _update, ctx) {
      const result = controller.execute(args, ctx, signal);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
    },
  });
  pi.on("session_start", (_event, ctx) => controller.restore(ctx));
  pi.on("session_tree", (_event, ctx) => controller.restore(ctx));
  pi.on("input", (event, ctx) => controller.input(event, ctx));
  pi.on("before_agent_start", (event, ctx) => controller.beforeStart(event.prompt, ctx));
  pi.on("agent_start", (_event, ctx) => controller.agentStarted(ctx));
  pi.on("message_start", (event, ctx) => controller.messageStarted(event.message, ctx));
  pi.on("message_end", (event, ctx) => controller.messageEnded(event, ctx));
  pi.on("tool_execution_start", (event, ctx) => controller.toolStarted(event, ctx));
  pi.on("tool_execution_end", (event, ctx) => controller.toolEnded(event, ctx));
  pi.on("tool_call", (event, ctx) => controller.toolCall(event, ctx));
  pi.on("agent_before_settle", (event, ctx) => controller.beforeSettle(event, ctx));
  pi.on("agent_settled", (_event, ctx) => controller.settled(ctx));
  pi.on("context", (event, ctx) => controller.context(event.messages, ctx));
  pi.on("session_shutdown", (_event, ctx) => controller.shutdown(ctx));
}
