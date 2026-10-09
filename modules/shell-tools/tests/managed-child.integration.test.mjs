import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createPiFixture, text } from "./helpers/pi-fixture.mjs";

// Actual Pi loader/session/shell operations, isolated home/auth/settings, no provider request.
test("managed child host keeps foreground shell across reload and prevents background side effects", { timeout: 60000 }, async () => {
  const previous = process.env.PI_SUBAGENTS_GUARD;
  const saved = globalThis.__piSubagentsGuardExpected;
  const heartbeat = setInterval(() => console.log("Managed child host verification in progress..."), 5000);
  const fixture = await createPiFixture();
  try {
    delete globalThis.__piSubagentsGuardExpected;
    process.env.PI_SUBAGENTS_GUARD = JSON.stringify({ id: "host-managed", cwd: "/fixture", startupPath: "/fixture/startup", shellMode: "foreground-v1" });
    const shellNames = process.platform === "win32" ? ["bash", "powershell"] : ["bash"];
    const { session, cwd } = await fixture.createSession({ defaultTools: [...shellNames, "shell_job_status", "shell_job_cancel"] });
    for (const name of ["bash", "powershell"]) {
      const tool = session.getToolDefinition(name);
      assert.ok(!("background" in tool.parameters.properties));
      assert.deepEqual(tool.outputSchema, (name === "bash" ? fixture.sdk.createBashToolDefinition(cwd) : fixture.sdk.createPowerShellToolDefinition(cwd)).outputSchema);
    }
    assert.equal(session.getToolDefinition("shell_job_status"), undefined);
    assert.equal(session.getToolDefinition("shell_job_cancel"), undefined);
    assert.deepEqual(session.getActiveToolNames(), shellNames);
    const marker = path.join(cwd, "forbidden");
    for (const name of shellNames) {
      const result = await fixture.execute(session, name, { command: name === "bash" ? "printf CHILD_SYNC_OK" : "Write-Output CHILD_SYNC_OK", timeoutMs: 5000 });
      assert.equal(result.structuredContent.output.trim(), "CHILD_SYNC_OK");
      assert.equal(result.structuredContent.exit_code, 0);
      const forbidden = name === "bash" ? "printf forbidden > forbidden" : "Set-Content -LiteralPath forbidden -Value forbidden";
      for (const background of [true, false, null]) {
        await assert.rejects(fixture.execute(session, name, { command: forbidden, background }), /foreground-only/);
        assert.equal(fs.existsSync(marker), false);
      }
      for (const timeoutMs of [0, 1.5, 2147483648]) {
        await assert.rejects(fixture.execute(session, name, { command: forbidden, timeoutMs }), /timeoutMs must/);
        assert.equal(fs.existsSync(marker), false);
      }
      const preAbort = new AbortController(); preAbort.abort();
      await assert.rejects(fixture.execute(session, name, { command: forbidden }, { signal: preAbort.signal }), /Command aborted/);
      assert.equal(fs.existsSync(marker), false);
    }
    const inherited = await fixture.execute(session, "bash", { command: "printf '%s' \"${PI_SUBAGENTS_GUARD:-cleared}\"" });
    assert.equal(inherited.structuredContent.output, "cleared");
    const abort = new AbortController(); let ready = false;
    await assert.rejects(fixture.execute(session, "bash", { command: "printf CHILD_READY; while :; do :; done" }, {
      signal: abort.signal, onUpdate(update) { if (text(update).includes("CHILD_READY")) { ready = true; abort.abort(); } },
    }), /Command aborted/);
    assert.equal(ready, true);
    await session.reload();
    assert.ok(!("background" in session.getToolDefinition("bash").parameters.properties));
    assert.equal(session.getToolDefinition("shell_job_cancel"), undefined);
    assert.equal((await fixture.execute(session, "bash", { command: "printf RELOAD_OK" })).structuredContent.exit_code, 0);
  } finally {
    clearInterval(heartbeat);
    fixture.cleanup();
    if (previous === undefined) delete process.env.PI_SUBAGENTS_GUARD; else process.env.PI_SUBAGENTS_GUARD = previous;
    if (saved === undefined) delete globalThis.__piSubagentsGuardExpected; else globalThis.__piSubagentsGuardExpected = saved;
  }
});
