import { appendFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import tuiObserver from "./tui-observer.ts";

const execute = promisify(execFile);
/** Test-only workflow gate probe; not a product gate or automatic repair. */
export default function workflowObserver(pi: ExtensionAPI): void {
  const record = (value: unknown) => appendFileSync(process.env.FILE_AUDIT_AB_JOURNAL!, JSON.stringify(value) + "\n");
  tuiObserver(pi, {
    WF_READ: [{ name: "read", args: { path: "modules/workflow/config.mjs" } }],
    WF_WORK: [
      { name: "read", args: { path: "modules/workflow/feature.mjs" } },
      { name: "edit", args: { path: "modules/workflow/feature.mjs", edits: [{ oldText: "answer = 1", newText: "answer = 2" }] } },
      { name: "workflow_test", args: {} },
    ],
    WF_CONTEXT_PROBE: [],
  });
  pi.registerTool({
    name: "workflow_test", label: "Feature test", description: "Run the isolated fixture's real feature-only Node test.", parameters: Type.Object({}),
    async execute(_id, _args, _signal, _update, ctx) {
      try {
        const result = await execute(process.execPath, [join(ctx.cwd, "target-test.mjs")], { cwd: ctx.cwd, timeout: 10000 });
        record({ event: "target-test", exitCode: 0, stdout: result.stdout });
        return { content: [{ type: "text", text: result.stdout.trim() }], details: { exitCode: 0 } };
      } catch (error: any) {
        record({ event: "target-test", exitCode: error.code, stderr: String(error.stderr) });
        return { content: [{ type: "text", text: "Feature-only test failed" }], details: { exitCode: error.code }, isError: true };
      }
    },
  });
}
