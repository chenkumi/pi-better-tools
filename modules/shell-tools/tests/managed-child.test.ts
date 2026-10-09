import assert from "node:assert/strict";
import test from "node:test";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import shell, { withIdleTimeout } from "../extensions/timeout-ms.ts";
import guard from "../../subagents/extensions/subagent/child-guard.ts";
import { BACKGROUND_LIFECYCLE_SECTION, registerBackgroundLifecycleGuidance } from "../src/background-guidance.ts";
import { consumeManagedChildGuard, isManagedForegroundChild } from "../src/managed-child.ts";

const slot = globalThis as any;
function api() {
  const tools: any[] = [];
  return { tools, registerTool: (tool: any) => tools.push(tool), on() {}, registerToolRenderer() {}, registerMessageRenderer() {}, registerCommand() {}, getSettings() { throw new Error("execution settings must not be read"); } } as any;
}
for (const order of ["shell-first", "guard-first"]) test(`managed foreground definitions and direct-execute rejection (${order})`, async context => {
  // Pure contract probes: opt-in diagnostics must not inspect the real user's home.
  context.mock.method(fsPromises, "stat", async () => { throw Object.assign(new Error("isolated missing settings"), { code: "ENOENT" }); });
  syncBuiltinESMExports();
  const old = process.env.PI_SUBAGENTS_GUARD, saved = slot.__piSubagentsGuardExpected;
  try {
    delete slot.__piSubagentsGuardExpected;
    process.env.PI_SUBAGENTS_GUARD = JSON.stringify({ id: "managed", cwd: "/workspace", startupPath: "/startup", shellMode: "foreground-v1" });
    const pi = api();
    if (order === "guard-first") guard(pi);
    shell(pi);
    if (order === "shell-first") guard(pi);
    assert.equal(process.env.PI_SUBAGENTS_GUARD, undefined);
    assert.deepEqual(pi.tools.map((t: any) => t.name), ["bash", "powershell"]);
    for (const tool of pi.tools) {
      assert.equal(tool.defaultActive, false);
      assert.equal(tool.parameters.additionalProperties, false);
      assert.ok(!("background" in tool.parameters.properties));
      assert.ok(!tool.outputSchema.anyOf);
      assert.doesNotMatch(tool.description + tool.promptGuidelines.join(" "), /background|receipt|shell_job_/i);
      for (const inherited of [false, true]) for (const value of [true, false, undefined, null, "true"]) {
        const input = inherited ? Object.assign(Object.create({ background: value }), { command: "MUST_NOT_SPAWN" }) : { command: "MUST_NOT_SPAWN", background: value };
        assert.equal(Object.hasOwn(input, "background"), !inherited);
        await assert.rejects(tool.execute("direct", input, undefined, undefined,
          { cwd: "/workspace", sessionManager: { getSessionId: () => "managed" } }), /foreground-only/);
      }
    }
    const reload = api(); shell(reload);
    assert.deepEqual(reload.tools.map((t: any) => t.name), ["bash", "powershell"]);
  } finally {
    if (old === undefined) delete process.env.PI_SUBAGENTS_GUARD; else process.env.PI_SUBAGENTS_GUARD = old;
    if (saved === undefined) delete slot.__piSubagentsGuardExpected; else slot.__piSubagentsGuardExpected = saved;
    context.mock.restoreAll(); syncBuiltinESMExports();
  }
});

const fullMarker = { id: "managed", cwd: "/workspace", startupPath: "/startup", shellMode: "foreground-v1", model: "offline/model", thinkingLevel: "off", childTrusted: false,
  bridgeToken: "fixture-token", readyQuerySnapshot: { path: "/frozen", hash: "fixture-hash", leafId: "leaf" } };
const markerCases: [string, Record<string, unknown>, boolean][] = [
  ["full", fullMarker, true], ["unknown-mode", { ...fullMarker, shellMode: "unrecognized" }, false],
  ["legacy-no-mode", Object.fromEntries(Object.entries(fullMarker).filter(([key]) => key !== "shellMode")), false],
  ...(["id", "cwd", "startupPath"] as const).flatMap(key => [
    [`missing-${key}`, Object.fromEntries(Object.entries(fullMarker).filter(([field]) => field !== key)), false],
    ...["", null, 0].map(value => [`invalid-${key}-${String(value)}`, { ...fullMarker, [key]: value }, false]),
  ] as [string, Record<string, unknown>, boolean][]),
];
for (const [label, payload, selected] of markerCases) test(`managed identity does not infer incomplete/legacy marker: ${label}`, () => {
  const old = process.env.PI_SUBAGENTS_GUARD, saved = slot.__piSubagentsGuardExpected;
  try {
    delete slot.__piSubagentsGuardExpected;
    process.env.PI_SUBAGENTS_GUARD = JSON.stringify(payload);
    assert.equal(isManagedForegroundChild(), selected);
    const consumed = consumeManagedChildGuard();
    assert.deepEqual(consumed, payload, "all model/trust/bridge/snapshot payload remains intact");
    assert.equal(process.env.PI_SUBAGENTS_GUARD, undefined);
    consumed.model = "offline/learned";
    assert.strictEqual(consumeManagedChildGuard(), consumed, "guard learned-default updates share the same object after consumption/reload");
    assert.equal(consumeManagedChildGuard().model, "offline/learned");
    assert.deepEqual(consumed.readyQuerySnapshot, payload.readyQuerySnapshot);
    const pi = api(); shell(pi);
    assert.deepEqual(pi.tools.map((tool: any) => tool.name), selected ? ["bash", "powershell"] : ["shell_job_status", "shell_job_cancel", "bash", "powershell"]);
  } finally {
    if (old === undefined) delete process.env.PI_SUBAGENTS_GUARD; else process.env.PI_SUBAGENTS_GUARD = old;
    if (saved === undefined) delete slot.__piSubagentsGuardExpected; else slot.__piSubagentsGuardExpected = saved;
  }
});

test("shared Subagents guidance cannot reintroduce background instructions into a foreground child", () => {
  const saved = slot.__piSubagentsGuardExpected;
  try {
    slot.__piSubagentsGuardExpected = { id: "managed", cwd: "/workspace", startupPath: "/startup", shellMode: "foreground-v1" };
    let handler!: (event: any) => any;
    registerBackgroundLifecycleGuidance({ on: (_name: string, fn: any) => handler = fn, getActiveTools: () => ["bash"] } as any);
    const event = { systemPromptOptions: { sections: { [BACKGROUND_LIFECYCLE_SECTION]: "stale" } } };
    handler(event);
    assert.ok(!(BACKGROUND_LIFECYCLE_SECTION in event.systemPromptOptions.sections));
  } finally { if (saved === undefined) delete slot.__piSubagentsGuardExpected; else slot.__piSubagentsGuardExpected = saved; }
});

test("shared foreground idle core refreshes data deadlines without real waits", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let emit!: (data: Buffer) => void, aborted = false;
  const operations = { exec: async (_command: string, _cwd: string, options: any) => {
    assert.equal(options.timeout, undefined, "host absolute timer remains disabled");
    emit = options.onData;
    return await new Promise<never>((_resolve, reject) => options.signal.addEventListener("abort", () => {
      aborted = true; reject(new Error("Command aborted"));
    }, { once: true }));
  } };
  const running = withIdleTimeout(operations).exec("fake", "/", { onData() {}, timeout: 2 });
  const rejected = assert.rejects(running, /timeout:2/);
  context.mock.timers.tick(1000); emit(Buffer.from("progress"));
  context.mock.timers.tick(1500); assert.equal(aborted, false);
  context.mock.timers.tick(500); await rejected; assert.equal(aborted, true);
});

test("shared foreground core preserves parent cancellation precedence", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  const operations = { exec: async (_command: string, _cwd: string, options: any) => await new Promise<never>((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new Error("Command aborted")), { once: true });
  }) };
  const rejected = assert.rejects(withIdleTimeout(operations).exec("fake", "/", { onData() {}, timeout: 2, signal: controller.signal }), /^Error: Command aborted$/);
  controller.abort(); context.mock.timers.tick(2000); await rejected;
});

test("ordinary main definitions retain background contract without mode inference", () => {
  const saved = slot.__piSubagentsGuardExpected;
  try {
    delete slot.__piSubagentsGuardExpected;
    const pi = api(); shell(pi);
    assert.deepEqual(pi.tools.map((t: any) => t.name), ["shell_job_status", "shell_job_cancel", "bash", "powershell"]);
    for (const tool of pi.tools.filter((t: any) => ["bash", "powershell"].includes(t.name))) {
      assert.equal(tool.parameters.properties.background.type, "boolean");
      assert.equal(tool.outputSchema.anyOf[1].properties.status.const, "running");
    }
  } finally { if (saved !== undefined) slot.__piSubagentsGuardExpected = saved; }
});
