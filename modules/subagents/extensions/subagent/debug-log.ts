import { ulid } from "ulid";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/** Keep the settings namespace and log directory aligned with package.json name. */
export const SUBAGENTS_PROJECT_NAME = "pi-subagents";

export function getSubagentDebugLogDir(homeDir = os.homedir()): string {
	return path.join(homeDir, ".pi", "logs", SUBAGENTS_PROJECT_NAME);
}

export interface SubagentDebugInput {
	agent: string;
	task: string;
	taskPrompt: string;
	systemPrompt?: string;
}

export interface SubagentDebugFailure {
	taskId: string;
	input: SubagentDebugInput;
	status: string;
	exitCode: number;
	stopReason?: string;
	errorMessage?: string;
	finalResponse: string;
	subsessionLogPath?: string;
	subsessionLogError?: string;
}

export async function readGlobalDebugLogSetting(agentDir: string): Promise<boolean> {
	try {
		const parsed: unknown = JSON.parse(await fs.readFile(path.join(agentDir, "settings.json"), "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
		const settings = (parsed as Record<string, unknown>)[SUBAGENTS_PROJECT_NAME];
		return Boolean(settings && typeof settings === "object" && !Array.isArray(settings)
			&& (settings as Record<string, unknown>).debugLog === true);
	} catch {
		// Missing/invalid optional settings must leave debug capture disabled.
		return false;
	}
}

/** Save failure-only prompt/response diagnostics with private directory and file modes. */
export async function writeSubagentDebugFailure(
	failure: SubagentDebugFailure,
	options: { logsDir?: string; now?: Date } = {},
): Promise<string> {
	const logsDir = options.logsDir ?? getSubagentDebugLogDir();
	await fs.mkdir(logsDir, { recursive: true, mode: 0o700 });
	await fs.chmod(logsDir, 0o700);
	const createdAt = (options.now ?? new Date()).toISOString();
	const timestamp = createdAt.replace(/[:.]/gu, "-");
	const filePath = path.join(logsDir, `${timestamp}-${failure.taskId}-${ulid().toUpperCase()}.json`);
	const record = {
		version: 1,
		createdAt,
		debugLogPath: filePath,
		...failure,
	};
	await fs.writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
	await fs.chmod(filePath, 0o600);
	return filePath;
}
