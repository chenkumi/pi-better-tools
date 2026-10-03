import { resolve } from "node:path";
import { convertToLlm, serializeConversation, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ulid } from "ulid";
import { writeJsonFile, writeJsonStdout } from "../src/delivery.ts";
import { extractJson } from "../src/extract.ts";
import { compileSchema, type CompiledSchema } from "../src/schema.ts";

const TOOL = "json_output";
const PREFIX = "pi-json-schema:";
const FALLBACK_TIMEOUT_MS = 60_000;

/**
 * Structured output for non-interactive runs.
 *   --json-schema <json>   schema (root must be an object); activates the feature
 *   --json-output <path>   write the result to a file; without it the result goes to stdout as one JSON line
 * If the model never calls json_output, the result is recovered from its last message, then with one extraction call.
 */
export default function jsonSchemaExtension(pi: ExtensionAPI) {
  pi.registerFlag("json-schema", { type: "string", description: "JSON Schema (root type object) for the structured result; prints it to stdout unless --json-output is set" });
  pi.registerFlag("json-output", { type: "string", description: "Write the structured result to this file (relative to the working directory)" });

  let active = false;
  let schema: CompiledSchema | undefined;
  let outputPath: string | undefined;
  let prompts = 0;
  let accepted: { data: unknown; text: string } | undefined;
  let lastText = "";
  /** The model that actually answered; a virtual router model cannot be called directly. */
  let answeredBy: { provider: string; id: string } | undefined;
  let transcript: unknown[] = [];
  let failure: string | undefined;
  let cancelled = false;
  let finalized = false;
  let toolRegistered = false;
  const cancel = () => { cancelled = true; };

  const fail = (message: string) => {
    if (failure !== undefined) return;
    failure = message;
    process.stderr.write(`${PREFIX} ${message}\n`);
    process.exitCode = 1;
  };
  const clone = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

  pi.on("session_start", (_event, ctx) => {
    const schemaText = pi.getFlag("json-schema");
    const output = pi.getFlag("json-output");
    if (schemaText === undefined && output === undefined) return;
    active = true;
    try {
      if (typeof schemaText !== "string" || schemaText.trim() === "") throw new Error("--json-schema requires a non-empty JSON Schema string");
      if (output !== undefined && (typeof output !== "string" || output.trim() === "")) throw new Error("--json-output requires a file path");
      if (ctx.mode !== "print") throw new Error("structured output needs non-interactive text mode (-p, not --mode json)");
      schema = compileSchema(schemaText);
      outputPath = typeof output === "string" ? resolve(ctx.cwd, output) : undefined;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
      return;
    }
    // Repeated session_start (reload/new session) must not stack listeners or re-register the tool.
    process.off("SIGTERM", cancel);
    process.off("SIGHUP", cancel);
    process.prependListener("SIGTERM", cancel);
    if (process.platform !== "win32") process.prependListener("SIGHUP", cancel);
    if (toolRegistered) return;
    toolRegistered = true;
    pi.registerTool({
      name: TOOL,
      label: "JSON output",
      exposure: "model-only",
      description: "Submit the final structured result. The arguments are the result and must match the required schema.",
      promptSnippet: "Submit the final structured result",
      promptGuidelines: [`When the task is complete, call ${TOOL} exactly once with the final result instead of answering in prose.`],
      parameters: Type.Unsafe(schema.jsonSchema),
      async execute(_id: string, params: unknown) {
        const data = clone(params);
        const reason = schema!.validate(data);
        if (reason !== undefined) throw new Error(`${TOOL} arguments do not match the schema: ${reason}`);
        const text = JSON.stringify(data);
        if (accepted && accepted.text !== text) {
          fail("conflicting results: json_output was called twice with different content");
          // Returning (not throwing) lets every tool in the batch agree to terminate, so no further model request is made.
          return { content: [{ type: "text" as const, text: "A different result was already submitted; the run has failed." }], details: undefined, terminate: true };
        }
        accepted = { data, text };
        return { content: [{ type: "text" as const, text: "Result recorded." }], details: undefined, terminate: true };
      },
    } as never);
  });

  pi.on("input", () => {
    if (!active) return { action: "continue" as const };
    if (failure !== undefined) return { action: "handled" as const };
    if (outputPath === undefined && ++prompts > 1) {
      fail("stdout delivery accepts a single prompt; use --json-output for several");
      return { action: "handled" as const };
    }
    return { action: "continue" as const };
  });

  pi.on("message_end", (event) => {
    if (!active || failure !== undefined) return;
    const message = event.message as { provider?: string; model?: string; role?: string; content?: Array<{ type: string; text?: string }>; stopReason?: string; errorMessage?: string };
    if (message.role !== "assistant" || !Array.isArray(message.content)) return;
    if (message.provider && message.model) answeredBy = { provider: message.provider, id: message.model };
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      fail(message.errorMessage || `model request ${message.stopReason}`);
      return;
    }
    if (message.content.some((block) => block.type === "toolCall")) return;
    lastText = message.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
    // The host prints the final assistant text to stdout; a structured-output run keeps that stream free of prose
    // (it carries only the JSON result in stdout mode).
    return { message: { ...message, content: message.content.filter((block) => block.type !== "text") } as never };
  });

  pi.on("agent_end", (event) => {
    if (!active) return;
    transcript = [...transcript, ...event.messages];
    // An upstream error or abort is a failed run; never try to recover a result from it.
    const last = [...event.messages].reverse().find((message) => (message as { role?: string }).role === "assistant") as { stopReason?: string; errorMessage?: string } | undefined;
    if (last && (last.stopReason === "error" || last.stopReason === "aborted")) fail(last.errorMessage || `model request ${last.stopReason}`);
  });

  async function recover(ctx: ExtensionContext): Promise<unknown | undefined> {
    const fromText = extractJson(lastText);
    if (fromText && schema!.validate(fromText.value) === undefined) return fromText.value;
    if (!pi.getActiveTools().includes(TOOL)) {
      fail(`no valid result was produced and ${TOOL} is not an active tool, so extraction is not allowed`);
      return undefined;
    }
    const model = (answeredBy && ctx.modelRegistry.find(answeredBy.provider, answeredBy.id)) || ctx.model;
    if (!model) {
      fail("no valid result was produced and no model is available for extraction");
      return undefined;
    }
    const conversation = serializeConversation(convertToLlm(transcript as never));
    let reply;
    try {
      reply = await ctx.modelRegistry.complete(model, {
        systemPrompt: `You extract structured data. Call ${TOOL} once with a result that matches its schema, using only facts from the conversation.`,
        messages: [{ role: "user", content: [{ type: "text", text: `Extract the final result from this conversation.\n\n<conversation>\n${conversation}\n</conversation>` }], timestamp: Date.now() }],
        tools: [{ name: TOOL, description: "Submit the final structured result.", parameters: Type.Unsafe(schema!.jsonSchema) }],
      } as never, { signal: AbortSignal.timeout(FALLBACK_TIMEOUT_MS), cacheRetention: "none", sessionId: ulid().toLowerCase() } as never);
    } catch (error) {
      fail(`extraction request failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
    if (reply.stopReason === "error" || reply.stopReason === "aborted") {
      fail(`extraction request failed: ${reply.errorMessage || reply.stopReason}`);
      return undefined;
    }
    for (const block of reply.content as Array<{ type: string; name?: string; arguments?: unknown; text?: string }>) {
      if (block.type === "toolCall") {
        if (block.name !== TOOL) { fail(`extraction call used an unexpected tool "${block.name}"`); return undefined; }
        const data = clone(block.arguments);
        const reason = schema!.validate(data);
        if (reason === undefined) return data;
        fail(`extraction result does not match the schema: ${reason}`);
        return undefined;
      }
    }
    const text = (reply.content as Array<{ type: string; text?: string }>).filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
    const extracted = extractJson(text);
    const reason = extracted ? schema!.validate(extracted.value) : "no JSON found in the extraction response";
    if (extracted && reason === undefined) return extracted.value;
    fail(`extraction result is unusable: ${reason}`);
    return undefined;
  }

  pi.on("session_shutdown", async (_event, ctx) => {
    process.off("SIGTERM", cancel);
    process.off("SIGHUP", cancel);
    if (!active || !schema || finalized) return;
    finalized = true;
    // Let any signal listeners already queued by this tick run first: a terminated run delivers nothing.
    await new Promise<void>((done) => setImmediate(done));
    if (cancelled && failure === undefined) process.stderr.write(`${PREFIX} terminated before the result was delivered\n`);
    if (cancelled || failure !== undefined) return;
    try {
      const data = accepted ? accepted.data : await recover(ctx);
      if (cancelled || failure !== undefined || data === undefined) return;
      if (outputPath === undefined) await writeJsonStdout(data);
      else await writeJsonFile(outputPath, data);
    } catch (error) {
      fail(`could not deliver the result: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}
