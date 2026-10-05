import type { SpawnOptions } from "./pty-manager.ts";

export type Transport = "local" | "wsl" | "ssh";
export interface LaunchPlan {
	command: string;
	args: string[];
	options: SpawnOptions;
	target: string;
	transport: Transport;
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.length || value.includes("\0")) throw new Error(`Invalid ${label}`);
	return value;
}
export function quotePosix(value: string): string {
	if (value.includes("\0")) throw new Error("NUL is not allowed in remote arguments");
	return "'" + value.replaceAll("'", "'\\''") + "'";
}

/** Resolve only explicitly named targets; never fall back to local. No I/O or processes. */
export function resolveTarget(command: string, args: string[], options: SpawnOptions & { target?: string }, defaultCwd: string, settings: unknown, platform: NodeJS.Platform = process.platform): LaunchPlan {
	const target = options.target ?? "local";
	if (target === "local") return { command, args, options, target, transport: "local" };
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(target)) throw new Error("Invalid PTY target name");
	if (!record(settings) || !record(settings.targets) || !Object.hasOwn(settings.targets, target)) {
		// Settings reach here already trust-filtered by the host; list names only (never host/cwd/distribution values).
		const names = record(settings) && record(settings.targets) ? Object.keys(settings.targets).filter(name => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)).sort() : [];
		throw new Error(`Unknown PTY target: ${target}. Configured targets: ${names.length ? names.join(", ") : "(none)"}; "local" is the default.`);
	}
	const config = settings.targets[target];
	if (!record(config) || !["ssh", "wsl"].includes(String(config.transport))) throw new Error(`Invalid PTY target: ${target}`);
	const allowed = config.transport === "ssh" ? ["transport", "host", "cwd"] : ["transport", "distribution", "cwd"];
	if (Object.keys(config).some(key => !allowed.includes(key))) throw new Error(`Unsupported PTY target setting: ${target}`);
	const cwd = text(options.cwd ?? config.cwd, "target cwd (required)");
	if (!cwd.startsWith("/")) throw new Error("Target cwd must be an absolute POSIX path");
	text(command, "command");
	if (!command.trim()) throw new Error("Remote command cannot be empty");
	if (command.startsWith("-")) throw new Error("Remote command cannot start with '-'");
	// env treats KEY=value as an assignment even after "--"; pass variables through the env option instead.
	if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(command)) throw new Error("Remote command cannot look like a KEY=value assignment; use the env option");
	for (const arg of args) if (arg.includes("\0")) throw new Error("NUL is not allowed in remote arguments");
	const env = Object.entries(options.env ?? {}).map(([key, value]) => {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid remote environment name: ${key}`);
		if (value.includes("\0")) throw new Error("NUL is not allowed in remote environment");
		return `${key}=${value}`;
	});
	// cwd/env here belong to the target. The local transport uses the Pi workspace.
	const clientOptions = { cols: options.cols, rows: options.rows, cwd: defaultCwd };
	if (config.transport === "wsl") {
		if (platform !== "win32") throw new Error("WSL targets require a Windows host");
		const distribution = text(config.distribution, "WSL distribution");
		if (distribution.startsWith("-")) throw new Error("Invalid WSL distribution");
		return { command: "wsl.exe", args: ["--distribution", distribution, "--cd", cwd, "--exec", "env", "--", ...env, command, ...args], options: clientOptions, target, transport: "wsl" };
	}
	const host = text(config.host, "SSH host alias");
	if (!/^[A-Za-z0-9_][A-Za-z0-9_.@-]*$/.test(host)) throw new Error("Invalid SSH host alias");
	const script = `cd ${quotePosix(cwd)} && exec env -- ${[...env, command, ...args].map(quotePosix).join(" ")}`;
	// Host key checking is not disabled and not overridden: the user's ssh config/known_hosts decide
	// (an explicit StrictHostKeyChecking=yes would break accept-new users). Authentication is non-interactive via keys/agent.
	return { command: "ssh", args: ["-tt", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", host, `sh -c ${quotePosix(script)}`], options: clientOptions, target, transport: "ssh" };
}
