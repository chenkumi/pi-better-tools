import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ulid } from "ulid";
import { buildManagedChildEnvironment, buildSubagentPiArgs } from "../extensions/subagent/child-args.ts";

// Real CLI + loader + startup guard; close RPC via EOF, never send a prompt.
test("offline managed CLI new/resume/ready-query loads foreground Shell in either extension order", { timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "child-shell-cli-"));
  const progress = setInterval(() => console.log("Managed child CLI verification in progress..."), 5000);
  try {
    const sdk = await import("@earendil-works/pi-coding-agent");
    assert.equal(sdk.VERSION, "1.1.0");
    const agentDir = path.join(root, "agent"), home = path.join(root, "home"), cwd = fs.realpathSync(root);
    fs.mkdirSync(agentDir); fs.mkdirSync(home);
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
    const runtime = await sdk.ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    const model = runtime.getModels()[0]; assert.ok(model);
    const selected = `${model.provider}/${model.id}`;
    const guardPath = fileURLToPath(new URL("../extensions/subagent/child-guard.ts", import.meta.url));
    const shellPath = fileURLToPath(new URL("../../shell-tools/src/index.ts", import.meta.url));
    const probePath = fileURLToPath(new URL("./fixtures/managed-child-shell-probe.ts", import.meta.url));
    const cli = fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
    for (const kind of ["new", "resume", "ready-query"]) for (const order of ["shell-first", "guard-first"]) {
      console.log(`Checking managed CLI ${kind} ${order}...`);
      const id = ulid().toUpperCase(), sessionDir = path.join(root, id);
      let persistence = { kind: "new", sessionDir, sessionId: id };
      if (kind !== "new") {
        const native = sdk.SessionManager.create(cwd, sessionDir, { id });
        native.appendMessage({ role: "user", content: "Offline fixture checkpoint", timestamp: Date.now() });
        persistence = { kind: "resume", sessionDir, sessionFile: native.getSessionFile() };
      }
      const startupPath = path.join(root, `${id}-startup.json`), resultPath = path.join(root, `${id}-result.json`);
      const args = buildSubagentPiArgs({ persistence, transport: "rpc", model: selected, thinkingLevel: "off", guardPath, taskPath: "", tools: kind === "ready-query" ? undefined : ["bash", "powershell", "shell_job_status", "shell_job_cancel", "subagent"] });
      // Only reorder explicit extensions; keep the builder's identity/exclusion args intact.
      const guardIndex = args.indexOf("-e"); args.splice(guardIndex, 2);
      args.push("--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes");
      for (const extension of order === "shell-first" ? [shellPath, guardPath] : [guardPath, shellPath]) args.push("-e", extension);
      args.push("-e", probePath);
      if (kind === "ready-query") args.push("--no-tools");
      const env = { ...buildManagedChildEnvironment({ id, cwd, startupPath, model: selected, thinkingLevel: "off", childTrusted: false }), HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", CHILD_SHELL_PROBE_RESULT: resultPath, CHILD_SHELL_PROBE_READY_QUERY: kind === "ready-query" ? "1" : "0" };
      const proc = spawn(process.execPath, [cli, ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, timeout: 30000, killSignal: "SIGKILL" });
      proc.stdin.on("error", () => {}); // preserve exit/stderr evidence for startup rejection
      let stdout = "", stderr = "";
      proc.stdout.on("data", data => stdout += data); proc.stderr.on("data", data => stderr += data);
      // Request ready state (no provider); orderly EOF is sent after its response.
      proc.stdin.write(JSON.stringify({ id: "offline-state", type: "get_state" }) + "\n");
      proc.stdout.on("data", () => { if (stdout.includes('"id":"offline-state"')) proc.stdin.end(); });
      const exitCode = await new Promise((resolve, reject) => { proc.once("error", reject); proc.once("close", resolve); });
      assert.equal(exitCode, 0, stderr);
      assert.equal(fs.existsSync(resultPath), true, stderr + stdout);
      const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
      assert.equal(result.passed, true); assert.equal(result.sessionId, id);
      assert.deepEqual(result.tools, kind === "ready-query" ? [] : ["bash", "powershell"]);
      assert.equal(JSON.parse(fs.readFileSync(startupPath, "utf8")).errorCode, undefined);
    }
  } finally { clearInterval(progress); fs.rmSync(root, { recursive: true, force: true }); }
});
