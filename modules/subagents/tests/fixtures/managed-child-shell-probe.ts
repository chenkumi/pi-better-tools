import assert from "node:assert/strict";
import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    const tools = pi.getAllTools();
    const readyQuery = process.env.CHILD_SHELL_PROBE_READY_QUERY === "1";
    assert.equal((globalThis as any).__piSubagentsGuardExpected?.shellMode, "foreground-v1");
    // Pi --no-tools omits configured tools from getAllTools too, not merely activation.
    if (readyQuery) assert.deepEqual(tools, []);
    for (const name of readyQuery ? [] : ["bash", "powershell"]) {
      const shell = tools.find(tool => tool.name === name)!;
      assert.ok(shell, name);
      assert.ok(!("background" in (shell.parameters as any).properties));
      assert.doesNotMatch(shell.description + (shell.promptGuidelines ?? []).join(" "), /background|receipt|shell_job_/i);
    }
    assert.ok(!tools.some(tool => ["shell_job_status", "shell_job_cancel"].includes(tool.name)));
    assert.ok(!pi.getActiveTools().some(name => name.startsWith("subagent")));
    assert.equal(process.env.PI_SUBAGENTS_GUARD, undefined);
    fs.writeFileSync(process.env.CHILD_SHELL_PROBE_RESULT!, JSON.stringify({ passed: true, mode: ctx.mode, tools: pi.getActiveTools(), sessionId: ctx.sessionManager.getSessionId() }));
  });
}
