import { createHash } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { forksDir } from "./store.ts";

const VALUE_FLAGS = new Set(["-e", "--extension", "--skill", "--prompt-template", "--theme"]);
const PROMPT_FLAGS = new Set(["--system-prompt", "--append-system-prompt"]);
const BOOLEAN_FLAGS = new Set(["-ne", "--no-extensions", "-ns", "--no-skills", "-np", "--no-prompt-templates", "--no-themes", "-nc", "--no-context-files", "--offline"]);

export interface ForwardedArgs { args: string[]; temporaryFiles: string[] }

/** Re-creates the resource/prompt selection the parent Pi was launched with. Only a closed allow-list is forwarded:
 *  provider, model, tool, session and trust flags are rebuilt by the Fork from verified parent state instead. */
export function forwardParentArgs(argv: readonly string[], launchCwd: string, jobId: string, workCwd: string): ForwardedArgs {
	const args: string[] = [], temporaryFiles: string[] = [];
	const absolute = (value: string) => (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) || isAbsolute(value) ? value : resolve(launchCwd, value);
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i]!;
		const eq = token.startsWith("--") ? token.indexOf("=") : -1;
		const flag = eq > 0 ? token.slice(0, eq) : token;
		if (BOOLEAN_FLAGS.has(flag)) { args.push(flag); continue; }
		if (!VALUE_FLAGS.has(flag) && !PROMPT_FLAGS.has(flag)) continue;
		const value = eq > 0 ? token.slice(eq + 1) : argv[++i];
		if (value === undefined) continue;
		if (VALUE_FLAGS.has(flag)) { args.push(flag, absolute(value)); continue; }
		// Inline prompt text must not sit on a command line: hand it over as an owner-only file.
		const candidate = absolute(value);
		if (existsSync(candidate)) { args.push(flag, candidate); continue; }
		const file = join(forksDir(workCwd), `${jobId}.${createHash("sha256").update(flag).digest("hex").slice(0, 8)}.prompt.txt`);
		writeFileSync(file, value, { mode: 0o600, flag: "wx" });
		temporaryFiles.push(file);
		args.push(flag, file);
	}
	return { args, temporaryFiles };
}

export function removeTemporary(files: readonly string[]) { for (const file of files) { try { rmSync(file, { force: true }); } catch { /* best effort */ } } }
