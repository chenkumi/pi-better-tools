/** Module-internal value helpers shared by the subagent extension files. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function errorToString(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
