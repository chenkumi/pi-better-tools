import { statSync } from "node:fs";
import { delimiter, extname, join } from "node:path";

/** Extensions CreateProcess can start directly; .cmd/.bat and builtins still need an explicit cmd.exe. */
const DIRECT_EXTENSIONS = [".exe", ".com"];

const isFile = (path: string): boolean => { try { return statSync(path).isFile(); } catch { return false; } };

/**
 * node-pty on Windows looks a bare command up on PATH by exact file name, ignoring PATHEXT, so "ssh" never finds ssh.exe.
 * A bare name without an extension is resolved here to the first PATH entry holding `<name>.exe` or `<name>.com`;
 * anything else (paths, names with an extension, no match, other platforms) is returned unchanged so node-pty reports its own error.
 */
export function resolveWindowsCommand(command: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
	if (platform !== "win32" || !command || /[\\/:]/.test(command) || extname(command) !== "") return command;
	const pathKey = Object.keys(env).find(key => key.toLowerCase() === "path");
	const dirs = (pathKey ? env[pathKey] ?? "" : "").split(delimiter).map(dir => dir.trim().replace(/^"|"$/g, "")).filter(Boolean);
	for (const dir of dirs) {
		for (const ext of DIRECT_EXTENSIONS) {
			const candidate = join(dir, command + ext);
			if (isFile(candidate)) return candidate;
		}
	}
	return command;
}
