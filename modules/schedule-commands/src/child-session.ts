/**
 * The real child session for agent jobs, built on the Pi SDK: one in-memory AgentSession per run, no persistence.
 * This extension is never loaded into the child (its own scheduler would re-fire the shared jobs), and extensions
 * and skills are opt-in per job. Verified against Pi 1.5.0 types only; a run against a real model is not part of the offline tests.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model } from "@earendil-works/pi-ai";
import {
	createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager, SettingsManager,
	type AgentSession, type ExtensionContext, type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { AgentJob, ChildFactory, ChildResult, ChildSession } from "./agent-run.ts";
import { LiveTranscript } from "../../../shared/src/background/index.ts";

const OWN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..").toLowerCase();
const BASE_TOOLS = ["bash", "read", "edit", "write", "grep", "find", "ls"];

const isOwn = (ext: { path?: string; resolvedPath?: string }) =>
	[ext.resolvedPath, ext.path].some((p) => p !== undefined && resolve(p).toLowerCase().startsWith(OWN_DIR));
const enabled = (v: boolean | string[] | undefined) => v === true || (Array.isArray(v) && v.length > 0);
const names = (v: boolean | string[] | undefined) => (Array.isArray(v) && v.length > 0 ? v : undefined);

/** "provider/id" exact first, then id or name matches among models that have credentials. */
export function resolveModel(registry: ExtensionContext["modelRegistry"], wanted: string): Model<any> | undefined {
	let needle = wanted;
	const slash = wanted.indexOf("/");
	if (slash !== -1) {
		const exact = registry.find(wanted.slice(0, slash), wanted.slice(slash + 1));
		if (exact) return exact;
		needle = wanted.slice(slash + 1);
	}
	const lower = needle.toLowerCase();
	const available = registry.getAvailable();
	return available.find((m) => m.id.toLowerCase() === lower) ?? available.find((m) => m.id.toLowerCase().includes(lower)) ?? available.find((m) => m.name.toLowerCase().includes(lower));
}

const hostRuntime = (registry: ExtensionContext["modelRegistry"]): ModelRuntime | undefined => {
	const runtime = (registry as unknown as { runtime?: ModelRuntime }).runtime;
	return runtime && typeof runtime.getModel === "function" ? runtime : undefined;
};

/** The final assistant message decides: provider error, self-abort, or (no message at all) nothing came back. */
function failureOf(session: AgentSession, streamed: string): string | undefined {
	for (let i = session.messages.length - 1; i >= 0; i--) {
		const message = session.messages[i] as { role?: string; stopReason?: string; errorMessage?: string };
		if (message.role !== "assistant") continue;
		if (message.stopReason === "error") return message.errorMessage || "the provider returned an error";
		if (message.stopReason === "aborted") return message.errorMessage || "the child session stopped before completing";
		return undefined;
	}
	return streamed.trim() ? undefined : "the child session finished without an assistant response";
}

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

/** Same order as the host's runtime disposal: tell the child's extensions it is shutting down, then dispose. */
async function teardown(session: AgentSession): Promise<string | undefined> {
	let failure: string | undefined;
	try {
		const runner = (session as unknown as { extensionRunner?: { hasHandlers?: (n: string) => boolean; emit: (e: unknown) => Promise<unknown> } }).extensionRunner;
		if (runner?.hasHandlers?.("session_shutdown")) await runner.emit({ type: "session_shutdown", reason: "quit" });
	} catch (error) { failure = `session_shutdown failed: ${error instanceof Error ? error.message : String(error)}`; }
	try { session.dispose?.(); }
	catch (error) { failure ??= `dispose failed: ${error instanceof Error ? error.message : String(error)}`; }
	return failure;
}

export function createChildFactory(context: () => ExtensionContext, trusted: () => boolean): ChildFactory {
	return async (job: AgentJob): Promise<ChildSession> => {
		const ctx = context();
		const model = resolveModel(ctx.modelRegistry, job.model);
		if (!model) {
			const sample = ctx.modelRegistry.getAvailable().slice(0, 5).map((m) => `${m.provider}/${m.id}`).join(", ");
			throw new Error(`model: unknown model ${JSON.stringify(job.model)}${sample ? `; available: ${sample}` : "; no model has credentials configured"}`);
		}
		const agentDir = getAgentDir();
		const extList = names(job.extensions), skillList = names(job.skills);
		// One settings manager with the parent's trust decision applied, shared by the loader and the session.
		const settingsManager = SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: trusted() });
		const loader = new DefaultResourceLoader({
			cwd: ctx.cwd, agentDir, settingsManager,
			noExtensions: !enabled(job.extensions), noSkills: !enabled(job.skills), noPromptTemplates: true, noThemes: true,
			...(enabled(job.extensions) && {
				extensionsOverride: (base) => ({ ...base, extensions: base.extensions.filter((ext) => !isOwn(ext) && (!extList || extList.some((n) => ext.path.toLowerCase().includes(n.toLowerCase())))) }),
			}),
			...(skillList && { skillsOverride: (base) => ({ ...base, skills: base.skills.filter((s) => skillList.includes(s.name || "")) }) }),
		});
		await loader.reload();
		const { session } = await createAgentSession({
			cwd: ctx.cwd, agentDir, sessionManager: SessionManager.inMemory(ctx.cwd), settingsManager,
			modelRuntime: hostRuntime(ctx.modelRegistry), model,
			tools: enabled(job.extensions) ? undefined : BASE_TOOLS, resourceLoader: loader,
		});
		if (enabled(job.extensions)) await session.bindExtensions({});
		const transcript = new LiveTranscript();
		return {
			transcript,
			async run(prompt: string): Promise<ChildResult> {
				let streamed = "";
				const unsubscribe = session.subscribe((event) => {
					transcript.ingest(event);
					if (event.type === "message_start") streamed = "";
					else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") streamed += event.assistantMessageEvent.delta;
				});
				try { await session.prompt(prompt); } finally { unsubscribe(); }
				const failure = failureOf(session, streamed);
				return { text: streamed.trim() || finalText(session), ...(failure ? { failure } : {}) };
			},
			abort: () => { void session.abort(); },
			dispose: () => teardown(session),
		};
	};
}
