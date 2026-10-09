import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  keyText,
  type ExtensionAPI,
  type GrepToolInput,
  type FindToolInput,
  type LsToolInput,
} from "@earendil-works/pi-coding-agent";

export const GREP_PREVIEW_LINES = 5;

/** Same-name overrides, not a loadout manager: Pi retains activation and hook authority. */
export function registerSearchTools(pi: ExtensionAPI): void {
  const grep = createGrepToolDefinition(process.cwd());
  const find = createFindToolDefinition(process.cwd());
  const ls = createLsToolDefinition(process.cwd());

  const grepOverride: typeof grep = {
    ...grep,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    annotations: { readOnlyHint: true, openWorldHint: false },
    defaultActive: false,
    renderResult(result, options, theme, context) {
      if (options.expanded) return grep.renderResult!(result, options, theme, context);
      const output = result.content.filter(block => block.type === "text").map(block => block.text).join("\n").trim();
      const lines = output ? output.split("\n") : [];
      if (lines.length <= GREP_PREVIEW_LINES) return grep.renderResult!(result, options, theme, context);
      const remaining = lines.length - GREP_PREVIEW_LINES;
      // Only a display copy is shortened. Host rendering retains truncation warnings,
      // component reuse and the active keybinding hint; actual results stay intact.
      const preview = lines.slice(0, GREP_PREVIEW_LINES).join("\n")
        + `\n${theme.fg("muted", `... (${remaining} more lines,`)} ${theme.fg("dim", keyText("app.tools.expand"))}${theme.fg("muted", " to expand")}${theme.fg("muted", ")")}`;
      return grep.renderResult!({ ...result, content: [{ type: "text", text: preview }] }, { ...options, expanded: true }, theme, context);
    },
    prepareArguments: args => normalizeOptionalNulls(args) as GrepToolInput,
    execute: (id, args, signal, onUpdate, ctx) => createGrepToolDefinition(ctx.cwd).execute(id, args, signal, onUpdate, ctx),
  };
  pi.registerTool(grepOverride);
  pi.registerTool({
    ...find,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    annotations: { readOnlyHint: true, openWorldHint: false },
    defaultActive: false,
    prepareArguments: args => normalizeOptionalNulls(args) as FindToolInput,
    execute: (id, args, signal, onUpdate, ctx) => createFindToolDefinition(ctx.cwd).execute(id, args, signal, onUpdate, ctx),
  });
  pi.registerTool({
    ...ls,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    annotations: { readOnlyHint: true, openWorldHint: false },
    defaultActive: false,
    prepareArguments: args => normalizeOptionalNulls(args) as LsToolInput,
    execute: (id, args, signal, onUpdate, ctx) => createLsToolDefinition(ctx.cwd).execute(id, args, signal, onUpdate, ctx),
  });
}

/** Match host provider nullable optionals; required fields remain for host validation. */
function normalizeOptionalNulls(args: unknown): Record<string, unknown> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) throw new Error("Search tool input must be an object.");
  const result = { ...args } as Record<string, unknown>;
  for (const key of ["path", "glob", "ignoreCase", "literal", "context", "limit"]) {
    if (result[key] === null) delete result[key];
  }
  return result;
}
