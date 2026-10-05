export const MAX_WAIT_FOR_LENGTH = 200;

/** Compiles the pty_read waitFor pattern (JavaScript RegExp source, multiline). Throws an actionable error. */
export function compileWaitFor(source: string): RegExp {
	if (typeof source !== "string" || source.length === 0) throw new Error("waitFor must be a non-empty regular expression string, e.g. \"\\$ $\" or \"Password:\".");
	if (source.length > MAX_WAIT_FOR_LENGTH) throw new Error(`waitFor is too long (${source.length} > ${MAX_WAIT_FOR_LENGTH} characters); use a shorter pattern.`);
	// Nested quantifiers such as (a+)+ can backtrack catastrophically on large buffers.
	if (/\([^()]*[+*][^()]*\)[+*{]/.test(source)) throw new Error("waitFor rejected: nested quantifiers like (a+)+ can hang; simplify the pattern.");
	try {
		return new RegExp(source, "m");
	} catch (error) {
		throw new Error(`Invalid waitFor regular expression: ${error instanceof Error ? error.message : String(error)}. Pass a JavaScript RegExp source without slashes or flags; escape special characters with a backslash.`);
	}
}
