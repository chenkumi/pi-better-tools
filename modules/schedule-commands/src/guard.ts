/** Shared admission rule: a job that runs shell commands needs the matching shell tool to be enabled. */
export type ShellName = "bash" | "powershell";

export const defaultShell = (platform: NodeJS.Platform = process.platform): ShellName => (platform === "win32" ? "powershell" : "bash");

/**
 * Returns the problem text (naming arguments only) or undefined when allowed. This checks whether the tool is
 * enabled, not whether a policy would allow the call, and never falls back to the other shell.
 */
export function shellProblem(activeTools: readonly string[], shell: ShellName): string | undefined {
	return activeTools.includes(shell) ? undefined : `shell: "${shell}" needs the ${shell} tool to be enabled; ask the user to enable it`;
}
