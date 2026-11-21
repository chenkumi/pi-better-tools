/**
 * What a goal runs on: every task (an implementation, a review) is one Pi SDK `AgentSession` of this process, with a session file under
 * the goal's own folder (`sessions/`) so the work can be read afterwards. No extension is loaded into it (so it cannot submit plans or start
 * schedules, and nothing of this package runs twice); it has Pi's built-in tools, the project's context files and the parent's model.
 * Verified against Pi 1.6.0 types and a fake model only; a run against a real model is not part of the offline tests.
 */
import { join } from "node:path";
import {
	createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager, SettingsManager,
	type AgentSession, type ExtensionContext, type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { runCommand } from "./command.ts";
import { REVIEW_TOOLS } from "./review.ts";
import type { GoalHost, ImplementTask } from "./runner.ts";
import { goalsDir } from "./store.ts";

const BASE_TOOLS = ["bash", "read", "edit", "write", "grep", "find", "ls"];

const hostRuntime = (registry: ExtensionContext["modelRegistry"]): ModelRuntime | undefined => {
	const runtime = (registry as unknown as { runtime?: ModelRuntime }).runtime;
	return runtime && typeof runtime.getModel === "function" ? runtime : undefined;
};

/** The final assistant message decides: provider error, self-abort, or (no message at all) nothing came back. */
function failureOf(session: AgentSession): string | undefined {
	for (let i = session.messages.length - 1; i >= 0; i--) {
		const message = session.messages[i] as { role?: string; stopReason?: string; errorMessage?: string };
		if (message.role !== "assistant") continue;
		if (message.stopReason === "error") return message.errorMessage || "the provider returned an error";
		if (message.stopReason === "aborted") return message.errorMessage || "the session stopped before completing";
		return undefined;
	}
	return "the session finished without an assistant response";
}

/** The text of the last assistant message that has any. */
function finalText(session: AgentSession): string {
	for (let i = session.messages.length - 1; i >= 0; i--) {
		const message = session.messages[i] as { role?: string; content?: unknown };
		if (message.role !== "assistant") continue;
		const parts = Array.isArray(message.content) ? message.content : [message.content];
		const text = parts.map((p) => (typeof p === "string" ? p : (p as { type?: string; text?: string } | undefined)?.type === "text" ? (p as { text: string }).text : "")).join("").trim();
		if (text) return text;
	}
	return "";
}

/** Tells the session's extensions it is shutting down (Pi's `dispose` does not), then disposes it. */
async function teardown(session: AgentSession): Promise<void> {
	try {
		const runner = (session as unknown as { extensionRunner?: { hasHandlers?: (n: string) => boolean; emit: (e: unknown) => Promise<unknown> } }).extensionRunner;
		if (runner?.hasHandlers?.("session_shutdown")) await runner.emit({ type: "session_shutdown", reason: "quit" });
	} catch { /* a failing handler must not hide the result */ }
	try { session.dispose?.(); } catch { /* already gone */ }
}

export function createGoalHost(context: () => ExtensionContext, thinking: () => ThinkingLevel): GoalHost {
	async function run(task: ImplementTask, signal: AbortSignal, readOnly: boolean): Promise<{ ok: boolean; summary: string }> {
		if (signal.aborted) return { ok: false, summary: "stopped" };
		const ctx = context();
		if (!ctx.model) throw new Error("No model is selected in the session that submitted the goal.");
		const agentDir = getAgentDir();
		// The project is trusted (the goal does not run otherwise), and the loader and the session share one settings manager.
		const settingsManager = SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: true });
		const loader = new DefaultResourceLoader({ cwd: ctx.cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true });
		await loader.reload();
		const { session } = await createAgentSession({
			cwd: ctx.cwd, agentDir, settingsManager, resourceLoader: loader,
			sessionManager: SessionManager.create(ctx.cwd, join(goalsDir(ctx.cwd), task.goalId, "sessions")),
			modelRuntime: hostRuntime(ctx.modelRegistry), model: ctx.model, thinkingLevel: thinking(),
			// A review reads and searches only.
			tools: readOnly ? REVIEW_TOOLS : BASE_TOOLS,
		});
		// The signal may have fired during the awaits above, before a listener could hear it.
		if (signal.aborted) { await teardown(session); return { ok: false, summary: "stopped" }; }
		session.setSessionName(task.name);
		const stop = () => void session.abort().catch(() => undefined);
		signal.addEventListener("abort", stop, { once: true });
		try {
			await session.prompt(task.prompt);
			const failure = failureOf(session);
			if (signal.aborted) return { ok: false, summary: "stopped" };
			return failure ? { ok: false, summary: failure } : { ok: true, summary: finalText(session) };
		} finally {
			signal.removeEventListener("abort", stop);
			await teardown(session);
		}
	}

	return {
		trusted: async () => context().isProjectTrusted(),
		implement: (task, signal) => run(task, signal, false),
		review: (task, signal) => run(task, signal, true),
		check: (command, signal) => runCommand(command, context().cwd, signal),
	};
}
