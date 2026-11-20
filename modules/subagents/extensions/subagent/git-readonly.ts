/** Command policy for a managed child whose shell is limited to `git diff`, `git log` and `git show`.
 * The command is validated token by token and rewritten to a fixed, hardened prefix. Anything that
 * could make a shell do more than run git (separators, substitution, redirection, quoting, globs,
 * variables) is outside the accepted character set, so it is rejected instead of parsed.
 * This is a tool contract enforced in the child's `tool_call` hook, not an OS sandbox.
 */
const SUBCOMMANDS = new Set(["diff", "log", "show"]);
const TOKEN = /^[A-Za-z0-9_.,/:=+%^~-]+$/;
// Options that write files, run external programs or read outside the repository. Git accepts any unique
// abbreviation of a long option, so every prefix of these (at least one character after `--`) is rejected too.
const DANGEROUS = ["--output", "--ext-diff", "--textconv", "--no-index", "--open-files-in-pager"];
const HARDENED_PREFIX = ["git", "--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false"];
const HARDENED_DIFF_OPTIONS = ["--no-ext-diff", "--no-textconv"];

export type GitReadonlyVerdict = { ok: true; command: string } | { ok: false; reason: string };

export function checkGitReadonly(command: unknown): GitReadonlyVerdict {
	if (typeof command !== "string") return { ok: false, reason: "command must be a string" };
	const tokens = command.trim().split(/ +/);
	if (tokens[0] !== "git" || !SUBCOMMANDS.has(tokens[1] ?? "")) return { ok: false, reason: "only `git diff`, `git log` and `git show` are allowed" };
	const args = tokens.slice(2);
	for (const token of args) {
		if (!TOKEN.test(token) || token.startsWith("~")) return { ok: false, reason: `argument ${JSON.stringify(token)} is not allowed: use plain refs, paths and options without quotes, spaces, wildcards, variables, separators or redirection` };
		if (token.startsWith("--") && token.length > 2) {
			const name = token.split("=")[0]!;
			if (DANGEROUS.some((option) => option.startsWith(name))) return { ok: false, reason: `option ${name} is not allowed` };
		}
	}
	return { ok: true, command: [...HARDENED_PREFIX, tokens[1]!, ...HARDENED_DIFF_OPTIONS, ...args].join(" ") };
}
