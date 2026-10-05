/** Optional `pi-pty-terminal.env` policy. Without it the whole process.env is inherited (default). */
export interface EnvPolicy {
	/** When present, only matching variables are inherited (an empty list inherits nothing). */
	allow?: string[];
	/** Matching variables are removed after `allow` is applied. */
	deny?: string[];
}

const NAME = /^[A-Za-z_][A-Za-z0-9_()]*\*?$/;

function list(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !NAME.test(item))) {
		throw new Error(`Invalid pi-pty-terminal.env.${label}: expected an array of variable names (a trailing * matches a prefix)`);
	}
	return value as string[];
}

/** Reads the policy from the (host-resolved, trust-aware) `pi-pty-terminal` settings. Invalid config fails closed. */
export function parseEnvPolicy(settings: unknown): EnvPolicy | undefined {
	if (settings === null || typeof settings !== "object" || Array.isArray(settings)) return undefined;
	const raw = (settings as Record<string, unknown>).env;
	if (raw === undefined) return undefined;
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid pi-pty-terminal.env: expected an object with allow and/or deny");
	const record = raw as Record<string, unknown>;
	const unknown = Object.keys(record).find(key => key !== "allow" && key !== "deny");
	if (unknown) throw new Error(`Unsupported pi-pty-terminal.env setting: ${unknown}`);
	const policy: EnvPolicy = {};
	if (record.allow !== undefined) policy.allow = list(record.allow, "allow");
	if (record.deny !== undefined) policy.deny = list(record.deny, "deny");
	return policy.allow || policy.deny ? policy : undefined;
}

/** Applies allow then deny to the inherited environment. Names compare case-insensitively on Windows. */
export function filterEnv(source: Record<string, string | undefined>, policy: EnvPolicy | undefined, platform: NodeJS.Platform = process.platform): Record<string, string> {
	const fold = (value: string) => platform === "win32" ? value.toUpperCase() : value;
	const matches = (patterns: string[], name: string) => patterns.some(pattern => pattern.endsWith("*") ? fold(name).startsWith(fold(pattern.slice(0, -1))) : fold(name) === fold(pattern));
	const result: Record<string, string> = {};
	for (const [name, value] of Object.entries(source)) {
		if (value === undefined) continue;
		if (policy?.allow && !matches(policy.allow, name)) continue;
		if (policy?.deny && matches(policy.deny, name)) continue;
		result[name] = value;
	}
	return result;
}
