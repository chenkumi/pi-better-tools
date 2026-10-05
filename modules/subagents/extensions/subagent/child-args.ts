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

/**
 * Build the Pi CLI arguments for a child subagent process.
 *
 * `subagent` is explicitly excluded even when the package is installed
 * globally, so a child does not receive the recursive delegation tool in its
 * model-visible tool schema.
 */
export function buildSubagentPiArgs(options: SubagentPiArgsOptions): string[] {
	const rpc = options.transport === "rpc";
	const args = ["--mode", rpc ? "rpc" : "json", ...(!rpc ? ["-p"] : []), "--exclude-tools", "subagent,subagent_status,subagent_cancel,subagent_message"];
	const persistence = options.persistence;
	if (!persistence || !["new", "resume"].includes(persistence.kind)) throw new Error("Managed session persistence is required for every subagent child.");
	args.push("--session-dir", persistence.sessionDir);
	if (persistence.kind === "new") args.push("--session-id", persistence.sessionId);
	else args.push("--session", persistence.sessionFile);

	if (options.guardPath) args.push("-e", options.guardPath);
	if (rpc && options.bridgePath) args.push("-e", options.bridgePath);
	if (options.model) args.push("--model", options.model);
	if (options.thinkingLevel) args.push("--thinking", options.thinkingLevel);
	if (options.tools && options.tools.length > 0) args.push("--tools", options.tools.join(","));
	if (options.promptPath) args.push("--append-system-prompt", options.promptPath);
	if (!rpc) args.push(`@${options.taskPath}`);

	return args;
}
