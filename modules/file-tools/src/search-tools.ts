import {
  createLsToolDefinition,
  type ExtensionAPI,
  type LsToolInput,
} from "@earendil-works/pi-coding-agent";

/** Only ls is overridden here; grep/find are left to the host or FFF. */
export function registerSearchTools(pi: ExtensionAPI): void {
  const ls = createLsToolDefinition(process.cwd());
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
  for (const key of ["path", "limit"]) {
    if (result[key] === null) delete result[key];
  }
  return result;
}
