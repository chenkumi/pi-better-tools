/** Working directory resolution and the in-process approval memory for directories outside the project. */
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export type ResolvedCwd = { ok: true; cwd: string; outsideProject: boolean } | { ok: false; error: string };

const isInside = (root: string, target: string): boolean => {
	const rel = relative(root, target);
	return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
};

/**
 * Resolve to a real existing directory. Both sides go through realpath so links cannot make an outside
 * directory look inside; callers resolve again at every run, there is never a fallback directory.
 */
export function resolveCwd(projectCwd: string, requested?: string): ResolvedCwd {
	let root: string;
	try { root = realpathSync(projectCwd); }
	catch { return { ok: false, error: "cwd: the project directory is not accessible" }; }
	let real: string;
	try { real = realpathSync(requested === undefined ? root : resolve(root, requested)); }
	catch { return { ok: false, error: `cwd: ${JSON.stringify(requested)} does not exist (relative paths resolve against the project directory)` }; }
	try { if (!statSync(real).isDirectory()) return { ok: false, error: `cwd: ${JSON.stringify(requested)} is not a directory` }; }
	catch { return { ok: false, error: `cwd: ${JSON.stringify(requested)} is not accessible` }; }
	return { ok: true, cwd: real, outsideProject: !isInside(root, real) };
}

/**
 * Specs a person approved during this process. Deliberately not persisted: a job file can be edited by hand or
 * arrive with a cloned repository, so a stored flag would prove nothing. Only directories outside the project need it.
 */
export class CommandApprovals {
	readonly #approved = new Set<string>();
	#key(command: string, shell: string, cwd: string) { return `${shell}\0${process.platform === "win32" ? cwd.toLowerCase() : cwd}\0${command}`; }
	approve(command: string, shell: string, cwd: string): void { this.#approved.add(this.#key(command, shell, cwd)); }
	isApproved(command: string, shell: string, cwd: string): boolean { return this.#approved.has(this.#key(command, shell, cwd)); }
}
