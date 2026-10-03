import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, afterEach, before, test } from "node:test";
import { createPiFixture, render, text } from "./helpers/pi-fixture.mjs";

let fixture;
let heartbeat;
const windows = process.platform === "win32";
const shellNames = windows ? ["bash", "powershell"] : ["bash"];
const timeout = 60_000;

before(async () => {
  heartbeat = setInterval(() => console.log("Integration verification in progress..."), 5000);
  fixture = await createPiFixture();
});
afterEach(() => fixture?.disposeSessions());
after(() => {
  clearInterval(heartbeat);
  console.log("Cleaning up isolated Pi sessions, output files, and settings...");
  fixture?.cleanup();
});

async function shellSession(options = {}) {
  return fixture.createSession({ tools: shellNames, ...options });
}

function markerCommand(name, marker) {
  // Resolve inside the session cwd rather than assuming a particular Bash drive mapping.
  marker = path.basename(marker);
  return name === "bash"
    ? `printf forbidden > '${marker.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`
    : `Set-Content -LiteralPath '${marker.replace(/'/g, "''")}' -Value forbidden`;
}

test("package loader replaces only the timeout contract and preserves upstream metadata", { timeout }, async () => {
  // Do not apply a registry allowlist: inspect the inactive PowerShell definition on Unix too.
  const { session, resourceLoader, cwd } = await fixture.createSession({ defaultTools: shellNames });
  assert.equal(resourceLoader.getExtensions().extensions.length, 1);
  for (const name of ["bash", "powershell"]) {
    const definition = session.getToolDefinition(name);
    const builtin = name === "bash"
      ? fixture.sdk.createBashToolDefinition(cwd)
      : fixture.sdk.createPowerShellToolDefinition(cwd);
    assert.equal(definition.parameters.properties.timeoutMs.type, "integer");
    assert.equal(definition.parameters.properties.timeoutMs.minimum, 1);
    assert.equal(definition.parameters.properties.timeoutMs.maximum, 2_147_483_647);
    assert.equal(definition.parameters.additionalProperties, false);
    assert.ok(!("timeout" in definition.parameters.properties));
    assert.deepEqual(definition.outputSchema, builtin.outputSchema);
    assert.deepEqual(definition.constrainedSampling, builtin.constrainedSampling);
    assert.equal(typeof definition.renderCall, "function");
    assert.equal(typeof definition.renderResult, "function");
    assert.equal(definition.renderResult.toString(), builtin.renderResult.toString());
    assert.equal(definition.promptSnippet, builtin.promptSnippet);
    for (const guideline of builtin.promptGuidelines ?? []) {
      assert.ok(definition.promptGuidelines.includes(guideline));
    }
    assert.ok(definition.promptGuidelines.some((item) => item.includes("milliseconds")));
    assert.ok(!definition.description.includes("timeout in seconds"));
  }
});

test("[BUG-001] overrides preserve read-only defaultTools instead of activating shells", { timeout }, async () => {
  const baseline = await fixture.createSession({ loadOverride: false, defaultTools: ["read"] });
  const overridden = await fixture.createSession({ defaultTools: ["read"] });
  assert.deepEqual(baseline.session.getActiveToolNames(), ["read"]);
  assert.deepEqual(overridden.session.getActiveToolNames(), ["read"]);
});

test("empty/default loadouts, allowlists, and exclusions retain the user's tool selection", { timeout }, async () => {
  for (const options of [
    {}, { defaultTools: [] }, { tools: [] }, { tools: ["read"] },
    { excludeTools: shellNames }, { noTools: "all" },
    ...(windows ? [
      { defaultTools: ["powershell"] }, { tools: ["powershell"] },
      { defaultTools: ["-bash", "+powershell"] },
    ] : []),
  ]) {
    const baseline = await fixture.createSession({ ...options, loadOverride: false });
    const overridden = await fixture.createSession(options);
    assert.deepEqual(overridden.session.getActiveToolNames(), baseline.session.getActiveToolNames(), JSON.stringify(options));
  }
});

test("explicit shell activation works and reload does not reactivate disabled overrides", { timeout }, async () => {
  const { session } = await fixture.createSession({ defaultTools: ["read"] });
  for (const name of shellNames) {
    const selected = await fixture.createSession({ defaultTools: ["read", name] });
    assert.deepEqual(selected.session.getActiveToolNames(), ["read", name]);
  }
  session.setActiveToolsByName(["read", ...shellNames]);
  assert.deepEqual(session.getActiveToolNames(), ["read", ...shellNames]);
  session.setActiveToolsByName(["read"]);
  await session.reload();
  assert.deepEqual(session.getActiveToolNames(), ["read"]);
  assert.ok(session.getToolDefinition("bash").parameters.properties.timeoutMs);
});

test("[LIMIT-001] effective SDK memory overrides are read at each Bash execution", { timeout }, async () => {
  const { session, settingsManager } = await shellSession({
    settings: { shellCommandPrefix: "export TEST_PREFIX=memory" },
    globalSettings: { shellCommandPrefix: "export TEST_PREFIX=disk" },
  });
  const command = 'printf "%s" "$TEST_PREFIX"';
  const first = await fixture.execute(session, "bash", { command, timeoutMs: 3000 });
  assert.equal(first.structuredContent.output, "memory");
  settingsManager.applyOverrides({ shellCommandPrefix: "export TEST_PREFIX=live" });
  const second = await fixture.execute(session, "bash", { command, timeoutMs: 3000 });
  assert.equal(second.structuredContent.output, "live");
});

test("global/trusted project settings follow the host's effective settings and trust", { timeout }, async () => {
  for (const trusted of [false, true]) {
    const { session } = await shellSession({
      disk: true, trusted,
      globalSettings: { shellCommandPrefix: "export TEST_PREFIX=global" },
      projectSettings: { shellCommandPrefix: "export TEST_PREFIX=project" },
    });
    const result = await fixture.execute(session, "bash", {
      command: 'printf "%s" "$TEST_PREFIX"', timeoutMs: 3000,
    });
    assert.equal(result.structuredContent.output, trusted ? "project" : "global");
  }
});

test("session settings stay isolated and SDK agentDir wins over the ambient agent directory", { timeout }, async () => {
  const first = await shellSession({ settings: { shellCommandPrefix: "export TEST_PREFIX=first" } });
  const second = await shellSession({ settings: { shellCommandPrefix: "export TEST_PREFIX=second" } });
  fixture.writeGlobalSettings({ shellCommandPrefix: "export TEST_PREFIX=ambient" });
  const custom = await shellSession({
    disk: true, agentDir: path.join(fixture.temp, "custom-agent"),
    globalSettings: { shellCommandPrefix: "export TEST_PREFIX=custom" },
  });
  const input = { command: 'printf "%s" "$TEST_PREFIX"', timeoutMs: 3000 };
  for (const [host, expected] of [[first, "first"], [second, "second"], [custom, "custom"], [first, "first"]]) {
    assert.equal((await fixture.execute(host.session, "bash", input)).structuredContent.output, expected);
  }
});

test("disk edits take effect after host settings reload, not by a private disk reread", { timeout }, async () => {
  const { session, settingsManager } = await shellSession({
    disk: true, globalSettings: { shellCommandPrefix: "export TEST_PREFIX=before" },
  });
  const input = { command: 'printf "%s" "$TEST_PREFIX"', timeoutMs: 3000 };
  fixture.writeGlobalSettings({ shellCommandPrefix: "export TEST_PREFIX=after" });
  assert.equal((await fixture.execute(session, "bash", input)).structuredContent.output, "before");
  await settingsManager.reload();
  assert.equal((await fixture.execute(session, "bash", input)).structuredContent.output, "after");
});

test("effective shellPath retains Pi's tilde, file URL, and Windows drive normalization", { timeout }, async () => {
  const missingName = `${path.basename(fixture.temp)}-missing-shell`;
  const missing = path.join(fixture.temp, missingName);
  const cases = [
    [pathToFileURL(missing).href, missing],
    [`~/${missingName}`, path.join(os.homedir(), missingName)],
  ];
  if (windows) {
    cases.push([`~\\${missingName}`, path.join(os.homedir(), missingName)]);
    const [, drive, rest] = /^([A-Za-z]):\\(.*)$/.exec(missing);
    for (const prefix of ["", "mnt/", "cygdrive/"]) {
      cases.push([`/${prefix}${drive.toLowerCase()}/${rest.replace(/\\/g, "/")}`, missing]);
    }
  }
  const { session, settingsManager } = await shellSession();
  for (const [shellPath, expected] of cases) {
    settingsManager.applyOverrides({ shellPath });
    await assert.rejects(
      fixture.execute(session, "bash", { command: "printf MUST_NOT_RUN", timeoutMs: 3000 }),
      (error) => error.message === `Custom shell path not found: ${expected}`,
      `normalized effective shellPath: ${shellPath}`,
    );
  }
});

test("renderer adapts milliseconds/sentinel, preserves legacy sessions, and does not mutate input", { timeout }, async () => {
  const { session } = await fixture.createSession({ defaultTools: shellNames });
  for (const name of ["bash", "powershell"]) {
    const definition = session.getToolDefinition(name);
    const args = Object.freeze({ command: "echo render", timeoutMs: 20_000 });
    assert.match(render(definition, args), /timeout 20s/);
    assert.equal(args.timeoutMs, 20_000);
    assert.ok(!("timeout" in args));
    assert.match(render(definition, { command: "echo render", timeout: 17 }), /timeout 17s/);
    assert.match(render(definition, { command: "echo render", timeout: 17, timeoutMs: 20_000 }), /timeout 20s/);
    assert.ok(!render(definition, { command: "echo render", timeoutMs: 2_147_483_647 }).includes("timeout"));
    assert.ok(!render(definition, { command: "echo render", timeout: 17, timeoutMs: 2_147_483_647 }).includes("timeout"));
    for (const partial of [{}, { timeoutMs: "200" }, { timeoutMs: NaN }, { timeoutMs: Infinity }]) {
      assert.doesNotThrow(() => render(definition, partial));
    }
  }
});

test("[BUG-002] renderer defensively tolerates undefined/null streaming arguments", { timeout }, async () => {
  const { session } = await fixture.createSession({ defaultTools: shellNames });
  for (const name of ["bash", "powershell"]) {
    for (const args of [undefined, null]) assert.doesNotThrow(() => render(session.getToolDefinition(name), args));
  }
});

test("real Bash execution preserves structured output, cwd, and session environment", { timeout }, async () => {
  const { session, cwd } = await shellSession();
  for (const key of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) {
    process.env[key] = "stale-parent";
  }
  fs.writeFileSync(path.join(cwd, "cwd-marker"), path.basename(cwd));
  const result = await fixture.execute(session, "bash", {
    command: 'printf "%s\\n" "$PI_SESSION_ID" "${PI_SESSION_FILE:-}" "$PI_PROVIDER" "$PI_MODEL" "$PI_REASONING_LEVEL"; cat ./cwd-marker',
    timeoutMs: 3000,
  });
  const [id, file, provider, model, reasoning, cwdMarker] = result.structuredContent.output.replace(/\r/g, "").trimEnd().split("\n");
  assert.equal(id, session.sessionManager.getSessionId());
  assert.equal(file, "");
  assert.equal(provider, "test-provider");
  assert.equal(model, "test-model");
  assert.equal(reasoning, "off");
  // Reading a unique relative marker verifies the actual cwd even when MSYS
  // maps the Windows temp directory to /tmp instead of a /c/... drive path.
  assert.equal(cwdMarker, path.basename(cwd));
  assert.equal(result.structuredContent.exit_code, 0);
  assert.equal(result.structuredContent.truncated, false);
  assert.match(text(result), /test-provider/);
});

test("real PowerShell keeps UTF-8 output and does not inherit Bash command prefixes", { timeout, skip: !windows && "Pi PowerShell backend requires native Windows" }, async () => {
  const { session } = await shellSession({ settings: { shellCommandPrefix: "exit 9" } });
  const result = await fixture.execute(session, "powershell", {
    command: "Write-Output '繁體中文 POWERSHELL_OK'", timeoutMs: 5000,
  });
  assert.match(text(result), /繁體中文 POWERSHELL_OK/);
  assert.equal(result.structuredContent.exit_code, 0);
});

test("AbortSignal reaches running shells and prevents post-abort side effects", { timeout }, async () => {
  const { session, cwd } = await shellSession();
  for (const name of shellNames) {
    const controller = new AbortController();
    const marker = path.join(cwd, `${name}-after-abort`);
    await fixture.execute(session, name, { command: markerCommand(name, marker), timeoutMs: 5000 });
    assert.equal(fs.existsSync(marker), true, "positive control: command can write in the session cwd");
    fs.rmSync(marker);
    let observedReady = false;
    const command = name === "bash"
      ? `printf 'ABORT_READY\\n'; sleep 2; ${markerCommand(name, marker)}`
      : `Write-Output 'ABORT_READY'; Start-Sleep -Seconds 2; ${markerCommand(name, marker)}`;
    await assert.rejects(fixture.execute(session, name, { command }, {
      signal: controller.signal,
      onUpdate(update) {
        if (text(update).includes("ABORT_READY")) {
          observedReady = true;
          controller.abort();
        }
      },
    }), /Command aborted/);
    assert.equal(observedReady, true, `${name} cancellation must happen after observable startup`);
    await new Promise((resolve) => setTimeout(resolve, 2300));
    assert.equal(fs.existsSync(marker), false, `${name} must not continue after cancellation`);
  }
});

test("legacy and invalid timeout inputs fail before starting real shell work", { timeout }, async () => {
  const { session, cwd } = await shellSession();
  const invalid = [
    { timeout: 3 }, { timeout: null },
    ...[null, 0, -1, 1.5, NaN, Infinity, "200", 2_147_483_648, Number.MAX_SAFE_INTEGER + 1]
      .map((timeoutMs) => ({ timeoutMs })),
  ];
  for (const name of shellNames) {
    const marker = path.join(cwd, `${name}-invalid`);
    for (const input of invalid) {
      await assert.rejects(fixture.execute(session, name, { command: markerCommand(name, marker), ...input }),
        /no longer accepts timeout|timeoutMs must/);
      assert.equal(fs.existsSync(marker), false);
    }
    await fixture.execute(session, name, { command: markerCommand(name, marker), timeoutMs: 5000 });
    assert.equal(fs.existsSync(marker), true, "positive control: rejected input was the only execution blocker");
    await assert.rejects(session.getToolDefinition(name).execute("missing-context", { command: "echo forbidden" }, undefined, undefined, undefined),
      /execution context/);
  }
});

test("nonzero shell exits preserve isError, exit_code, and output", { timeout }, async () => {
  const { session } = await shellSession();
  for (const name of shellNames) {
    const command = name === "bash" ? "echo NONZERO_OK; exit 7" : "Write-Output NONZERO_OK; exit 7";
    const result = await fixture.execute(session, name, { command, timeoutMs: 5000 });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.exit_code, 7);
    assert.match(result.structuredContent.output, /NONZERO_OK/);
  }
});

test("streaming and model-facing truncation retain full structured output and a recoverable file", { timeout }, async () => {
  const { session } = await shellSession();
  const updates = [];
  const result = await fixture.execute(session, "bash", {
    command: "for ((i=1; i<=2205; i++)); do printf 'test-line-%s\\n' \"$i\"; done", timeoutMs: 5000,
  }, { onUpdate: (update) => updates.push(update) });
  assert.ok(updates.length > 0);
  assert.ok(updates.some((update) => text(update).includes("test-line-")));
  assert.equal(result.details.truncation.truncated, true);
  assert.equal(result.details.truncation.outputLines, 2000);
  assert.ok(fs.existsSync(result.details.fullOutputPath));
  assert.match(fs.readFileSync(result.details.fullOutputPath, "utf8"), /test-line-1\r?\n/);
  assert.match(text(result), /test-line-2205/);
  assert.equal(result.structuredContent.truncated, false);
  assert.match(result.structuredContent.output, /test-line-1\r?\n/);
});

test("large streaming output is tracked for cleanup even when shell execution aborts", { timeout }, async () => {
  const { session } = await shellSession();
  const controller = new AbortController();
  let outputPath;
  await assert.rejects(fixture.execute(session, "bash", {
    command: "for ((i=1; i<=2205; i++)); do printf 'abort-line-%s\\n' \"$i\"; done; sleep 5",
  }, {
    signal: controller.signal,
    onUpdate(update) {
      if (update.details?.fullOutputPath) {
        outputPath = update.details.fullOutputPath;
        controller.abort();
      }
    },
  }), /Command aborted/);
  assert.ok(outputPath, "cancel only after a recoverable output file was created");
  assert.equal(path.dirname(outputPath), fixture.outputDir);
  assert.equal(fs.existsSync(outputPath), true);
  // The fixture's final cleanup asserts that this file and the isolated temp
  // root are both removed, even though there was no successful final result.
});

test("Pi 0.99.0 structured-output contract is preserved for each available shell", { timeout }, async () => {
  const { session } = await shellSession();
  for (const name of shellNames) {
    const empty = await fixture.execute(session, name, {
      command: name === "bash" ? ":" : "$null = $null", timeoutMs: 5000,
    });
    assert.equal(empty.structuredContent.output, "", `${name} represents empty output as an empty string`);
    assert.equal(empty.structuredContent.truncated, false);

    const command = name === "bash"
      ? "head -c 1100000 /dev/zero | tr '\\0' A"
      : "[Console]::Out.Write('A' * 1100000)";
    const result = await fixture.execute(session, name, { command, timeoutMs: 5000 });
    assert.equal(result.structuredContent.truncated, true, `${name} marks output over 1 MiB truncated`);
    // Pi's bound covers head/tail payload bytes; the omission marker is additional.
    assert.equal(result.structuredContent.output,
      "A".repeat(524_288) + "\n\n[... 51424 bytes omitted ...]\n\n" + "A".repeat(524_288));
    assert.ok(fs.existsSync(result.structuredContent.full_output_path), `${name} exposes the full output file`);
    assert.equal(fs.statSync(result.structuredContent.full_output_path).size, 1_100_000);
  }
});

test("codemode nested parallel shell calls use timeoutMs and structured return data", { timeout }, async () => {
  const { session } = await shellSession({ codemode: true, tools: [...shellNames, "codemode"] });
  const calls = [
    'tools.bash({command: "printf CODEMODE_BASH_OK", timeoutMs: 3000})',
    ...(windows ? ['tools.powershell({command: "Write-Output CODEMODE_PS_OK", timeoutMs: 5000})'] : []),
  ];
  const result = await fixture.execute(session, "codemode", {
    code: `const results = await Promise.all([${calls.join(",")}]); for (const result of results) text(result);`,
  });
  assert.ok(!result.isError, text(result));
  assert.match(text(result), /CODEMODE_BASH_OK/);
  if (windows) assert.match(text(result), /CODEMODE_PS_OK/);
  assert.match(text(result), /exit_code/);
});

test("codemode nonzero exits resolve structured data rather than hiding the exit code", { timeout }, async () => {
  const { session } = await shellSession({ codemode: true, tools: ["bash", "codemode"] });
  const result = await fixture.execute(session, "codemode", {
    code: 'const result = await tools.bash({command: "exit 7", timeoutMs: 3000}); text({exitCode: result.exit_code});',
  });
  assert.ok(!result.isError, text(result));
  assert.match(text(result), /exitCode.*7/);
});

test("codemode cannot implicitly activate an unselected direct shell override", { timeout }, async () => {
  const { session, cwd } = await fixture.createSession({ defaultTools: ["read", "codemode"], codemode: true });
  assert.deepEqual(session.getActiveToolNames(), ["read", "codemode"]);
  const marker = path.join(cwd, "codemode-disabled-bash");
  const result = await fixture.execute(session, "codemode", {
    code: `await tools.bash(${JSON.stringify({ command: markerCommand("bash", marker), timeoutMs: 3000 })});`,
  });
  assert.equal(result.isError, true, text(result));
  assert.equal(fs.existsSync(marker), false);
});
