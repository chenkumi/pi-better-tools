import type { SubsessionStatus } from "./subsession-log.ts";

export type TaskStatus = "running" | SubsessionStatus;

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Cumulative provider-reported tokens; distinct from the last context gauge. */
	totalTokens: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface CompactSubagentResult {
	taskId: string;
	agent: string;
	agentSource: "bundled" | "user" | "project" | "unknown";
	task: string;
	status: TaskStatus;
	exitCode: number;
	output: string;
	usage: UsageStats;
	logPath?: string;
	subagentSessionId?: string;
	canResume?: boolean;
	errorCode?: string;
	logError?: string;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, contextTokens: 0, turns: 0 };
}

/** Add one authoritative message's usage, never streaming snapshots or nested copies. */
export function addUsage(total: UsageStats, value: unknown): void {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const usage = value as Record<string, unknown>;
	const number = (entry: unknown) => typeof entry === "number" && Number.isFinite(entry) ? entry : 0;
	total.input += number(usage.input);
	total.output += number(usage.output);
	total.cacheRead += number(usage.cacheRead);
	total.cacheWrite += number(usage.cacheWrite);
	total.totalTokens += number(usage.totalTokens);
	const cost = usage.cost;
	total.cost += cost && typeof cost === "object" && !Array.isArray(cost) ? number((cost as Record<string, unknown>).total) : 0;
	// reasoning is a subset of output; cacheWrite1h is a subset of cacheWrite.
	// Neither should be added to token totals again.
}

export function isFailedResult(result: CompactSubagentResult): boolean {
	return result.status === "failed" || result.status === "aborted" || (result.status !== "running" && result.exitCode !== 0);
}

export function getResultOutput(result: CompactSubagentResult): string {
	if (!isFailedResult(result)) return result.output || "(no output)";
	if (result.output && result.errorMessage) return `${result.output}\n\nError: ${result.errorMessage}`;
	return result.output || result.errorMessage || "(no output)";
}

export function withLogPath(result: CompactSubagentResult, output = getResultOutput(result)): string {
	if (result.subagentSessionId) output += `\n\nSubagent session: ${result.subagentSessionId} (${result.canResume ? "ready to resume" : "not resumable"})`;
	if (result.logPath) return `${output}\n\nSubsession log: ${result.logPath}`;
	if (result.logError) return `${output}\n\nSubsession log unavailable: ${result.logError}`;
	return output;
}

export function formatParentTaskOutput(result: CompactSubagentResult, label?: string): string {
	const status = result.status === "running" ? "running" : result.status;
	const header = label ?? `[${result.agent}] ${status}`;
	return `### ${header}\n\n${withLogPath(result)}`;
}

export function formatParentResults(
	mode: "single" | "parallel" | "chain",
	results: CompactSubagentResult[],
): string {
	if (results.length === 0) return "(no output)";
	if (mode === "single") return withLogPath(results[0]);
	return results
		.map((result) =>
			formatParentTaskOutput(
				result,
				mode === "chain" ? `Step ${result.step ?? "?"} [${result.agent}] ${result.status}` : undefined,
			),
		)
		.join("\n\n---\n\n");
}

export function aggregateUsage(results: CompactSubagentResult[]): UsageStats {
	const total = emptyUsage();
	for (const result of results) {
		total.input += result.usage.input;
		total.output += result.usage.output;
		total.cacheRead += result.usage.cacheRead;
		total.cacheWrite += result.usage.cacheWrite;
		// Older saved details did not have totalTokens. Reconstruct from cumulative
		// counters rather than incorrectly reusing their final contextTokens gauge.
		total.totalTokens += result.usage.totalTokens ?? (result.usage.input + result.usage.output + result.usage.cacheRead + result.usage.cacheWrite);
		total.cost += result.usage.cost;
		total.contextTokens += result.usage.contextTokens;
		total.turns += result.usage.turns;
	}
	return total;
}

/** Return only the parent-safe fields, dropping child message and stderr traces. */
export function compactResult(input: CompactSubagentResult & Record<string, unknown>): CompactSubagentResult {
	const {
		taskId,
		agent,
		agentSource,
		task,
		status,
		exitCode,
		output,
		usage,
		logPath,
		subagentSessionId,
		canResume,
		errorCode,
		logError,
		model,
		stopReason,
		errorMessage,
		step,
	} = input;
	return {
		taskId,
		agent,
		agentSource,
		task,
		status,
		exitCode,
		output,
		usage,
		...(logPath ? { logPath } : {}),
		...(subagentSessionId ? { subagentSessionId, canResume: canResume === true } : {}),
		...(errorCode ? { errorCode } : {}),
		...(logError ? { logError } : {}),
		...(model ? { model } : {}),
		...(stopReason ? { stopReason } : {}),
		...(errorMessage ? { errorMessage } : {}),
		...(step === undefined ? {} : { step }),
	};
}
