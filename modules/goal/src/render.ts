import { Text } from "@earendil-works/pi-tui";

/** Tool text and goal logs are untrusted: strip control and bidi characters, collapse whitespace and bound the length. */
export function clean(value: unknown, max = 300): string {
	if (typeof value !== "string" && typeof value !== "number") return "";
	return String(value).slice(0, max * 4)
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

type Theme = { fg(key: string, text: string): string; bold(text: string): string };
type Result = { content: Array<{ type: string; text?: string }> };

/** The call as one line: the tool name and what it names (a goal id or the plan's title). */
export function renderCall(name: string, subject: (args: Record<string, unknown>) => unknown) {
	return (args: unknown, theme: Theme) => new Text(`${theme.fg("toolTitle", theme.bold(name))} ${theme.fg("accent", clean(subject((args ?? {}) as Record<string, unknown>), 80))}`.trimEnd(), 0, 0);
}

/** The result as text: two lines collapsed, everything (bounded) expanded; an error in the error colour. */
export function renderResult(name: string) {
	return (result: Result, options: { expanded: boolean; isPartial: boolean }, theme: Theme, context: { isError: boolean }) => {
		const lines = result.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n").split("\n").map((line) => clean(line, 400)).filter(Boolean);
		if (context.isError) return new Text(theme.fg("error", lines.slice(0, options.expanded ? 40 : 3).join("\n")), 0, 0);
		if (options.isPartial) return new Text(theme.fg("muted", lines[0] ?? `${name}…`), 0, 0);
		return new Text(theme.fg("muted", lines.slice(0, options.expanded ? 40 : 2).join("\n")), 0, 0);
	};
}
