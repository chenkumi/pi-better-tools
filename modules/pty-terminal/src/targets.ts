import type { SpawnOptions } from "./pty-manager.ts";

export type Transport = "local" | "wsl" | "ssh";
export interface LaunchPlan {
	command: string;
	args: string[];
	options: SpawnOptions;
	target: string;
	transport: Transport;
}

/** Valid configured target name; also filters which names an unknown-target error may list. */
const TARGET_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Bounded, single-line rendering of a received value for error messages (never used for secrets). */
const show = (value: string, max = 60): string => JSON.stringify(value.length > max ? value.slice(0, max) + "..." : value);
const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0 && !value.includes("\0");
// Agent-facing text: target problems come from the user's settings, so never name the settings keys or fields.
const ASK_USER = "Ask the user to fix the named terminal target in their settings";

export function quotePosix(value: string): string {
	if (value.includes("\0")) throw new Error("NUL is not allowed in remote arguments; remove NUL characters from the value.");
	return "'" + value.replaceAll("'", "'\''") + "'";
}

/** Resolve only explicitly named targets; never fall back to local. No I/O or processes. */
export function resolveTarget(command: string, args: string[], options: SpawnOptions & { target?: string }, defaultCwd: string, settings: unknown, platform: NodeJS.Platform = process.platform): LaunchPlan {
	const target = options.target ?? "local";
	if (target === "local") return { command, args, options, target, transport: "local" };
	if (!TARGET_NAME.test(target)) throw new Error(`Invalid PTY target name ${show(target)}: use letters, digits, '_' or '-' (starting with a letter or digit), or omit target to run locally.`);
	if (!record(settings) || !record(settings.targets) || !Object.hasOwn(settings.targets, target)) {
		// Settings reach here already trust-filtered by the host; list names only (never host/cwd/distribution values).
		const names = record(settings) && record(settings.targets) ? Object.keys(settings.targets).filter(name => TARGET_NAME.test(name)).sort() : [];
		throw new Error(`Unknown PTY target: ${target}. Configured targets: ${names.length ? names.join(", ") : "(none)"}; "local" is the default.`);
	}
	const config = settings.targets[target];
	if (!record(config) || !["ssh", "wsl"].includes(String(config.transport))) throw new Error(`PTY target "${target}" is misconfigured in the user's settings: its connection type must be SSH or WSL. ${ASK_USER}, or use another target or omit target for local.`);
	const allowed = config.transport === "ssh" ? ["transport", "host", "cwd"] : ["transport", "distribution", "cwd"];
	const unsupported = Object.keys(config).find(key => !allowed.includes(key));
	if (unsupported !== undefined) throw new Error(`PTY target "${target}" has an unsupported entry in the user's settings. ${ASK_USER}.`);
	const cwd = options.cwd ?? config.cwd;
	if (cwd === undefined || cwd === "") throw new Error(`PTY target "${target}" needs a working directory: pass the cwd parameter as an absolute POSIX path (e.g. "/home/user/project") or ask the user to set a default working directory for this target in their settings.`);
	if (!isText(cwd) || !cwd.startsWith("/")) throw new Error(`Invalid cwd ${typeof cwd === "string" ? show(cwd) : `(${typeof cwd})`} for PTY target "${target}": it must be an absolute POSIX path starting with "/" (e.g. "/home/user/project") without NUL characters.`);
	if (!isText(command)) throw new Error('Invalid command: parameter "command" must be a non-empty string without NUL characters (the executable name, e.g. "bash"; put options in args).');
	if (!command.trim()) throw new Error('Invalid command: parameter "command" is empty or only whitespace; pass the executable name, e.g. "bash".');
	if (command.startsWith("-")) throw new Error(`Invalid command ${show(command)}: it starts with '-' and would be parsed as an option; put the executable in command and options in args.`);
	// env treats KEY=value as an assignment even after "--"; pass variables through the env option instead.
	if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(command)) throw new Error(`Invalid command ${show(command)}: it looks like a KEY=value assignment; pass variables with the env parameter and put the executable in command.`);
	args.forEach((arg, index) => { if (arg.includes("\0")) throw new Error(`NUL is not allowed in remote arguments: args[${index}] contains a NUL character; remove it.`); });
	const env = Object.entries(options.env ?? {}).map(([key, value]) => {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid remote environment name ${show(key)}: use letters, digits and '_' only, not starting with a digit.`);
		if (value.includes("\0")) throw new Error(`NUL is not allowed in remote environment: the value of env "${key}" contains a NUL character; remove it.`);
		return `${key}=${value}`;
	});
	// cwd/env here belong to the target. The local transport uses the Pi workspace.
	const clientOptions = { cols: options.cols, rows: options.rows, cwd: defaultCwd };
	if (config.transport === "wsl") {
		if (platform !== "win32") throw new Error(`PTY target "${target}" uses WSL, which requires a Windows host; use an ssh target or omit target for local.`);
		const distribution = config.distribution;
		if (!isText(distribution) || distribution.startsWith("-")) throw new Error(`PTY target "${target}" has an invalid WSL system name in the user's settings: it must be a non-empty name not starting with '-' (e.g. "Ubuntu"). ${ASK_USER}.`);
		return { command: "wsl.exe", args: ["--distribution", distribution, "--cd", cwd, "--exec", "env", "--", ...env, command, ...args], options: clientOptions, target, transport: "wsl" };
	}
	const host = config.host;
	if (!isText(host) || !/^[A-Za-z0-9_][A-Za-z0-9_.@-]*$/.test(host)) throw new Error(`PTY target "${target}" has an invalid SSH connection alias in the user's settings: it must be an SSH config alias matching [A-Za-z0-9_][A-Za-z0-9_.@-]* (no spaces or leading '-'). ${ASK_USER}.`);
	const script = `cd ${quotePosix(cwd)} && exec env -- ${[...env, command, ...args].map(quotePosix).join(" ")}`;
	// Host key checking is not disabled and not overridden: the user's ssh config/known_hosts decide
	// (an explicit StrictHostKeyChecking=yes would break accept-new users). Authentication is non-interactive via keys/agent.
	return { command: "ssh", args: ["-tt", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", host, `sh -c ${quotePosix(script)}`], options: clientOptions, target, transport: "ssh" };
}
