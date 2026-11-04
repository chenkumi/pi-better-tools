import { FORK_TOOLS, PROGRESS_CHECKPOINT_TOOL, SUBAGENT_TOOLS } from "../../../../shared/src/contracts/index.ts";

/** Called only at owned managed-child spawn sites (new/resume/ready-query).
 * Keep identity explicit, not inferred from transport, cwd, or session files.
 * The child consumes the guard environment before tools can spawn grandchildren.
 */
export function buildManagedChildEnvironment(expected: { id: string; cwd: string; startupPath: string; [key: string]: unknown }): NodeJS.ProcessEnv {
	return { ...process.env, PI_SUBAGENTS_GUARD: JSON.stringify({ ...expected, shellMode: "foreground-v1" }) };
}

export type SessionPersistence =
	| { kind: "new"; sessionDir: string; sessionId: string }
	| { kind: "resume"; sessionDir: string; sessionFile: string };

export interface SubagentPiArgsOptions {
	persistence: SessionPersistence;
	model?: string;
	thinkingLevel?: string;
	tools?: string[];
	promptPath?: string;
	guardPath?: string;
	transport?: "json" | "rpc";
	bridgePath?: string;
	/** Absolute path to a generated UTF-8 task file, never raw task text. */
	taskPath: string;
}

/** The progress checkpoint anchor tool of Pi Auto Compact; a child with an explicit tool list still needs it to anchor long runs. A tool list of +name/-name entries cannot mix in a bare name. */
const withProgressCheckpoint = (tools: readonly string[]): string => (tools.some((tool) => tool.startsWith("+") || tool.startsWith("-")) ? `+${PROGRESS_CHECKPOINT_TOOL}` : PROGRESS_CHECKPOINT_TOOL);

/**
 * Build the Pi CLI arguments for a child subagent process.
 *
 * `subagent` is explicitly excluded even when the package is installed
 * globally, so a child does not receive the recursive delegation tool in its
 * model-visible tool schema. The Fork creation tools are excluded for the same reason:
 * no Subagent may create a Fork.
 */
export function buildSubagentPiArgs(options: SubagentPiArgsOptions): string[] {
	const rpc = options.transport === "rpc";
	const args = ["--mode", rpc ? "rpc" : "json", ...(!rpc ? ["-p"] : []), "--exclude-tools", [...SUBAGENT_TOOLS, ...FORK_TOOLS].join(",")];
	const persistence = options.persistence;
	if (!persistence || !["new", "resume"].includes(persistence.kind)) throw new Error("Managed session persistence is required for every subagent child.");
	args.push("--session-dir", persistence.sessionDir);
	if (persistence.kind === "new") args.push("--session-id", persistence.sessionId);
	else args.push("--session", persistence.sessionFile);

	if (options.guardPath) args.push("-e", options.guardPath);
	if (rpc && options.bridgePath) args.push("-e", options.bridgePath);
	if (options.model) args.push("--model", options.model);
	if (options.thinkingLevel) args.push("--thinking", options.thinkingLevel);
	if (options.tools && options.tools.length > 0) args.push("--tools", [...options.tools, withProgressCheckpoint(options.tools)].join(","));
	if (options.promptPath) args.push("--append-system-prompt", options.promptPath);
	if (!rpc) args.push(`@${options.taskPath}`);

	return args;
}
