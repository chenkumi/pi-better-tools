/**
 * Lightweight in-process subagent runner.
 *
 * Used when a scheduled job has `model` set: spawn a fresh AgentSession with
 * the chosen model, run the prompt to completion, return the assistant's text.
 * No subprocess, no extension recursion (noExtensions: true), no persistence.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isProjectTrusted } from "./trust.js";
import type { Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionContext,
  getAgentDir,
  type ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

/** Upper bound for one in-process run; a hung provider must not pin a job in "running" forever. */
export const SUBAGENT_TIMEOUT_MS = 30 * 60 * 1000;

/** Entry file of this extension, used to keep a child session from loading (and re-firing jobs of) its own scheduler. */
const SELF_ENTRY = resolve(fileURLToPath(new URL("./index.ts", import.meta.url)));

function isSelfExtension(ext: { path?: string; resolvedPath?: string }): boolean {
  const norm = (p: string | undefined) => (p ? resolve(p).toLowerCase() : undefined);
  const self = SELF_ENTRY.toLowerCase();
  return norm(ext.resolvedPath) === self || norm(ext.path) === self;
}

const DEFAULT_TOOL_NAMES = ["bash", "read", "edit", "write", "grep", "find", "ls"];

export type SubagentResult =
  | { ok: true; text: string; cleanupError?: string }
  | { ok: false; error: string; skipped?: boolean; cleanupError?: string };

export interface RunSubagentOptions {
  /** If true, load all extensions. If an array, only those named. Default undefined (none). */
  extensions?: boolean | string[];
  /** If true, load all skills. If an array, only those named. Default undefined (none). */
  skills?: boolean | string[];
}

export function resolveModel(
  registry: ExtensionContext["modelRegistry"],
  modelStr: string,
): Model<any> | undefined {
  let fuzzyNeedle = modelStr;
  const slash = modelStr.indexOf("/");
  if (slash !== -1) {
    const provider = modelStr.slice(0, slash);
    const id = modelStr.slice(slash + 1);
    const found = registry.find(provider, id);
    if (found) return found;
    // Slash-form didn't exact-match; fuzzy against the id portion only —
    // matching against "anthropic/haiku" would never find anything since model
    // ids don't include the provider prefix.
    fuzzyNeedle = id;
  }

  const needle = fuzzyNeedle.toLowerCase();
  const candidates = registry.getAvailable();
  return (
    candidates.find((m) => m.id.toLowerCase() === needle) ??
    candidates.find((m) => m.id.toLowerCase().includes(needle)) ??
    candidates.find((m) => m.name.toLowerCase().includes(needle))
  );
}

/**
 * Pi 1.0 hands extensions a `ModelRegistry` facade over the host's `ModelRuntime`
 * but exposes no public accessor. Reuse the host runtime when it is reachable so
 * extension-registered providers resolve; otherwise `createAgentSession` builds a
 * default runtime from agentDir (auth.json / models.json).
 */
function hostModelRuntime(registry: ExtensionContext["modelRegistry"]): ModelRuntime | undefined {
  const runtime = (registry as unknown as { runtime?: ModelRuntime }).runtime;
  return runtime && typeof runtime.getModel === "function" ? runtime : undefined;
}

export function getLastAssistantText(session: AgentSession): string {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i];
    if (msg.role !== "assistant") continue;
    const parts: string[] = [];
    if (typeof msg.content === "string") {
      parts.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const c of msg.content) {
        if (c && typeof c === "object" && (c as any).type === "text" && (c as any).text) {
          parts.push((c as any).text);
        }
      }
    }
    const text = parts.join("").trim();
    if (text) return text;
  }
  return "";
}

/** Error text of the final assistant message when the run ended in an error stop, else undefined. */
export function getLastAssistantError(session: AgentSession): string | undefined {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i] as any;
    if (msg.role !== "assistant") continue;
    return msg.stopReason === "error" ? msg.errorMessage || "Provider returned an error" : undefined;
  }
  return undefined;
}

/**
 * Terminal outcome of the child run, classified from its final assistant message:
 * a provider error, a child that stopped itself with stopReason "aborted" (the parent did not cancel it),
 * or a run that never produced an assistant message. Returns undefined for a normal completion.
 * Parent cancellation and timeout are decided by the caller before this is consulted.
 */
export function getChildFailure(session: AgentSession, streamedText = ""): string | undefined {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i] as any;
    if (msg.role !== "assistant") continue;
    if (msg.stopReason === "error") return msg.errorMessage || "Provider returned an error";
    if (msg.stopReason === "aborted") return msg.errorMessage || "Child session aborted before completing";
    return undefined;
  }
  return streamedText.trim() ? undefined : "Child session finished without an assistant response";
}

/**
 * Awaited child teardown in the same order as the host's AgentSessionRuntime.dispose():
 * emit session_shutdown to the child's extensions, then dispose the session. Failures are
 * returned (not swallowed) so the parent can keep the unconfirmed-cleanup state.
 */
async function disposeChild(session: AgentSession): Promise<string | undefined> {
  let failure: string | undefined;
  try {
    const runner = (session as any).extensionRunner;
    if (runner?.hasHandlers?.("session_shutdown")) {
      await runner.emit({ type: "session_shutdown", reason: "quit" });
    }
  } catch (err) {
    failure = `session_shutdown failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  try {
    session.dispose?.();
  } catch (err) {
    failure ??= `dispose failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  return failure;
}

export function describeAvailableModels(
  registry: ExtensionContext["modelRegistry"],
): string {
  const available = registry.getAvailable();
  if (available.length === 0) return "No models with configured auth.";
  const sample = available.slice(0, 5).map((m) => `${m.provider}/${m.id}`).join(", ");
  const more = available.length > 5 ? `, … (${available.length - 5} more)` : "";
  return `Available: ${sample}${more}`;
}

export async function runSubagentOnce(
  ctx: ExtensionContext,
  prompt: string,
  modelStr: string,
  signal?: AbortSignal,
  options: RunSubagentOptions = {},
  /** Internal admission guard after asynchronous initialization, not cancellation. */
  canStartPrompt?: () => boolean,
): Promise<SubagentResult> {
  const holder: { session?: AgentSession } = {};
  let result: SubagentResult;
  try {
    result = await runChild(holder, ctx, prompt, modelStr, signal, options, canStartPrompt);
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  // Awaited, so a caller that awaits this run also awaits the child's session_shutdown and disposal.
  if (holder.session) {
    const cleanupError = await disposeChild(holder.session);
    if (cleanupError) result = { ...result, cleanupError };
  }
  return result;
}

async function runChild(
  holder: { session?: AgentSession },
  ctx: ExtensionContext,
  prompt: string,
  modelStr: string,
  signal?: AbortSignal,
  options: RunSubagentOptions = {},
  /** Internal admission guard after asynchronous initialization, not cancellation. */
  canStartPrompt?: () => boolean,
): Promise<SubagentResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const model = resolveModel(ctx.modelRegistry, modelStr);
    if (!model) {
      return {
        ok: false,
        error: `Unknown model '${modelStr}'. ${describeAvailableModels(ctx.modelRegistry)}`,
      };
    }

    const agentDir = getAgentDir();

    // Helper: convert extensions/skills option to boolean and optionally filter.
    // An empty array means "none" — same as unset.
    const isEnabled = (v: boolean | string[] | undefined): boolean =>
      v === true || (Array.isArray(v) && v.length > 0);
    const getNameList = (v: boolean | string[] | undefined): string[] | undefined =>
      Array.isArray(v) && v.length > 0 ? v : undefined;

    const extList = getNameList(options.extensions);
    const skillList = getNameList(options.skills);

    // One SettingsManager with the parent's project-trust decision applied up front, shared by the
    // loader and the SDK: both would otherwise default to trusted and reload project settings/extensions.
    const settingsManager = SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: isProjectTrusted(ctx) });
    const loader = new DefaultResourceLoader({
      cwd: ctx.cwd,
      agentDir,
      settingsManager,
      // Prevent recursive loading of this extension into the subagent.
      // Context files (AGENTS.md / CLAUDE.md) are loaded by defaults.
      noExtensions: !isEnabled(options.extensions),
      noSkills: !isEnabled(options.skills),
      noPromptTemplates: true,
      noThemes: true,
      // Never load this extension into the child: its session_start would start a second
      // scheduler that re-fires the shared (workdir-scoped) jobs, recursively.
      ...(isEnabled(options.extensions) && {
        extensionsOverride: (base) => ({
          ...base,
          extensions: base.extensions.filter(
            (ext) =>
              !isSelfExtension(ext) &&
              (!extList || extList.some((name) => ext.path.toLowerCase().includes(name.toLowerCase()))),
          ),
        }),
      }),
      ...(skillList && {
        skillsOverride: (base) => ({
          ...base,
          skills: base.skills.filter((skill) =>
            skillList.includes(skill.name || ""),
          ),
        }),
      }),
    });
    await loader.reload();

    const created = await createAgentSession({
      cwd: ctx.cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(ctx.cwd),
      settingsManager,
      modelRuntime: hostModelRuntime(ctx.modelRegistry),
      model,
      tools: isEnabled(options.extensions) ? undefined : DEFAULT_TOOL_NAMES,
      resourceLoader: loader,
    });
    const active = created.session;
    holder.session = active;

    if (isEnabled(options.extensions)) {
      await active.bindExtensions({});
    }
    let onAbort: (() => void) | undefined;
    if (signal) {
      if (signal.aborted) {
        active.abort();
      } else {
        onAbort = () => active.abort();
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    let buffered = "";
    const unsubscribe = active.subscribe((event: AgentSessionEvent) => {
      if (event.type === "message_start") {
        buffered = "";
      } else if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        buffered += event.assistantMessageEvent.delta;
      }
    });

    let timedOut = false;
    timer = setTimeout(() => {
      timedOut = true;
      active.abort();
    }, SUBAGENT_TIMEOUT_MS);

    try {
      if (canStartPrompt && !canStartPrompt()) {
        return { ok: false, skipped: true, error: "Skipped: deadline reached or job unavailable before prompt start" };
      }
      await active.prompt(prompt);
    } finally {
      unsubscribe();
      if (signal && onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
    }

    if (timedOut) {
      return { ok: false, error: `Timed out after ${Math.round(SUBAGENT_TIMEOUT_MS / 60000)} minutes` };
    }
    // Provider failures usually surface as an assistant message with stopReason "error"
    // rather than a rejected prompt(); don't record those runs as successful.
    const failure = getChildFailure(active, buffered);
    if (failure) return { ok: false, error: failure };

    const text = buffered.trim() || getLastAssistantText(active);
    return { ok: true, text };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
