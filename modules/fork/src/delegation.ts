import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createForcedPromptAppender } from "../../pi-runtime/src/forced-prompt.js";
import { hasForkMarker } from "./identity.ts";

/** Opt-in guidance that makes the main agent prefer `fork`. Off by default: nothing is added to the system prompt. */
export const DELEGATION_SECTION = "pi_better_tools_fork_delegation";
/** Persisted in the session (like any custom entry) so the choice survives /resume and /reload and is copied into a Fork snapshot. */
export const DELEGATION_ENTRY_TYPE = "pi-better-tools.fork-delegation";

/** Identical text in the parent and in every Fork child (the system prompt is part of the cached prefix), so it must work for both readers.
 *  The last rule is the child's cue; it matches the fixed opening of the prompt a Fork receives (`FORK_PROMPT_PREFIX`). */
export const DELEGATION_GUIDANCE = [
	"### Fork delegation (on)",
	"Delegation mode is on: the user wants tasks done by Forks, not in this conversation. For any request that needs tool work (reading several files, creating or editing files, running commands, tests or builds), your first action must be a `fork` call with a self-contained task; do not start the work yourself. Answer directly only when no tools are needed (a question, an explanation, a one-line lookup) or when you need the user's decision before work can start.",
	"- The task text states the goal, paths, constraints and what to report. Start one Fork per independent piece; never start two Forks that edit the same files (shared workspace, no worktree).",
	"- After the fork call, tell the user in one sentence what started and stop. Do not poll or redo the Fork's work. Its result arrives later as a message in this conversation; check it, then report to the user.",
	"- If a message says \"You are the background Fork\", you ARE that Fork: ignore the rules above, do the task yourself with your own tools and end with a concise report. Fork tools are refused in your process.",
].join("\n");

let enabled = false;
let prompted = false;
/** The choice of this session; never read by a Fork child (it receives the parent's prompted value at launch). */
export const delegationEnabled = () => enabled;
export const setDelegationEnabled = (value: boolean) => { enabled = value; };
/** Whether the most recent system prompt of this process carried the guidance. A Fork child must build the same prompt. */
export const promptedDelegation = () => prompted;

/** The latest persisted choice on the entries, or off. */
export function readDelegation(entries: readonly { type?: string; customType?: string; data?: unknown }[]): boolean {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.type === "custom" && entry.customType === DELEGATION_ENTRY_TYPE) return (entry.data as { enabled?: unknown } | undefined)?.enabled === true;
	}
	return false;
}

/** Adds or removes the section on every run. `wanted` decides per run; the guidance is only present while the `fork` tool is active.
 *  A forced/custom prompt from another extension is kept in step, like the other structured sections. */
export function registerDelegationPrompt(pi: ExtensionAPI, wanted: (ctx: ExtensionContext) => boolean): void {
	const appendToForcedPrompt = createForcedPromptAppender();
	pi.on("before_agent_start", (event, ctx) => {
		const section = wanted(ctx) && pi.getActiveTools().includes("fork") ? DELEGATION_GUIDANCE : undefined;
		prompted = section !== undefined;
		const { sections } = event.systemPromptOptions;
		if (section) sections[DELEGATION_SECTION] = section;
		else delete sections[DELEGATION_SECTION];
		return appendToForcedPrompt(event, section);
	});
}

/** `/fork:delegate [on|off]` for the root session. A Fork conversation (cold /resume) can never fork, so it has nothing to switch. */
export function registerDelegationCommand(pi: ExtensionAPI): void {
	pi.registerCommand("fork:delegate", {
		description: "Fork delegation: /fork:delegate on|off (prefer fork for tasks)",
		handler: async (args, ctx) => {
			const say = (text: string, level: "info" | "warning" = "info") => { if (ctx.hasUI) ctx.ui.notify(text, level); };
			if (hasForkMarker(ctx.sessionManager.getEntries())) { say("Fork delegation is unavailable in a Fork conversation.", "warning"); return; }
			const word = String(args ?? "").trim().toLowerCase();
			if (word === "") { say(`Fork delegation: ${enabled ? "on" : "off"} (use /fork:delegate on|off)`); return; }
			if (word !== "on" && word !== "off") { say(`Unknown argument "${word.slice(0, 20)}"; use /fork:delegate on|off`, "warning"); return; }
			const next = word === "on";
			if (next !== enabled) { enabled = next; pi.appendEntry(DELEGATION_ENTRY_TYPE, { enabled: next }); }
			say(`Fork delegation: ${next ? "on" : "off"} (from the next run)`);
		},
	});
}
