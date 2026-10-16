import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import tuiObserver from "./tui-observer.ts";

const execute = promisify(execFile);
/** Test-only workflow and full-verifier comparator; not a product gate or automatic repair. */
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
  let fullRuns = 0;
  pi.registerCommand("workflow-full", {
    description: "Test-only comparator: run the unmodified full provenance verifier in this isolated fixture.",
    handler: async (_args, ctx) => {
      const metricsPath = join(ctx.cwd, `full-metrics-${++fullRuns}.json`);
      const started = performance.now();
      let exitCode = 0, stdout = "", stderr = "";
      try {
        const result = await execute(process.execPath, ["--import", new URL("./full-verifier-metrics.mjs", import.meta.url).href,
          join(ctx.cwd, "scripts/verify-sources.mjs")], { cwd: ctx.cwd, timeout: 15000,
          env: { ...process.env, FILE_AUDIT_FULL_METRICS: metricsPath } });
        stdout = result.stdout; stderr = result.stderr;
      } catch (error: any) {
        if (typeof error.code !== "number") throw error;
        exitCode = error.code; stdout = String(error.stdout); stderr = String(error.stderr);
      }
      const elapsedMs = performance.now() - started;
      let io;
      try { io = JSON.parse(await readFile(metricsPath, "utf8")); }
      catch (error) {
        record({ event: "full-verifier-launch-error", exitCode, stdout, stderr });
        throw new Error(`Full verifier metrics unavailable (exit ${exitCode}): ${stderr.slice(0, 1000)}`, { cause: error });
      }
      record({ event: "full-verification", run: fullRuns, exitCode, stdout, stderr, elapsedMs, io });
      ctx.ui.notify(`Full provenance: ${exitCode === 0 ? "PASSED" : "FAILED"} (exit ${exitCode})\n` +
        `Content files: ${io.contentFiles}; content bytes: ${io.contentBytes}; metadata bytes: ${io.metadataBytes}\n` +
        (exitCode ? stderr.slice(0, 1800) : "All fixture inventory checks passed."), exitCode ? "warning" : "info");
    },
  });
}
