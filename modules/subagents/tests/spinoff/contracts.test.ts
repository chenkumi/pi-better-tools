import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { buildSubagentPiArgs } from "../../src/spinoff-contract.ts";
import { getPiInvocation } from "../../src/spinoff-contract.ts";
import { activeJobCounts, publishCapability } from "../../../../shared/src/background/index.ts";
import { forwardParentArgs } from "../../src/spinoff/args.ts";
import { buildSpinoffPiArgs } from "../../src/spinoff/child.ts";
import { SUBAGENT_TOOLS } from "../../../../shared/src/contracts/index.ts";
import { SPINOFF_GUARD_ENV, SPINOFF_MARKER_TYPE, SPINOFF_TOOLS, spinoffCreationRefusal } from "../../src/spinoff/identity.ts";
import { unpairedToolCalls, writeSpinoffSession } from "../../src/spinoff/snapshot.ts";

const SLOT = Symbol.for("pi-better-tools.spinoff.child-guard.v1");
const MANAGED = "__piSubagentsGuardExpected";
const clean = () => { delete (globalThis as any)[SLOT]; delete (globalThis as any)[MANAGED]; delete process.env[SPINOFF_GUARD_ENV]; delete process.env.PI_SUBAGENTS_GUARD; };

test("role matrix: only a root session may create a Spinoff; trusted startup data decides, not arguments", () => {
	clean();
	assert.equal(spinoffCreationRefusal([]), undefined, "root");
	assert.match(spinoffCreationRefusal([{ type: "custom", customType: SPINOFF_MARKER_TYPE }])!, /itself a Spinoff/, "cold-resumed Spinoff conversation");
	assert.equal(spinoffCreationRefusal([{ type: "custom", customType: "something-else" }]), undefined);
	process.env[SPINOFF_GUARD_ENV] = JSON.stringify({ spinoffId: "F", token: "t" });
	assert.match(spinoffCreationRefusal([])!, /Spinoff process/, "Spinoff child via startup handshake");
	assert.equal(process.env[SPINOFF_GUARD_ENV], undefined, "handshake is consumed so descendants never inherit it");
	assert.match(spinoffCreationRefusal([])!, /Spinoff process/, "identity survives reload within the process");
	clean();
	process.env.PI_SUBAGENTS_GUARD = JSON.stringify({ id: "S", cwd: "/x", startupPath: "/y", shellMode: "foreground-v1" });
	assert.match(spinoffCreationRefusal([])!, /Subagent/, "Subagent managed child");
	clean();
	process.env[SPINOFF_GUARD_ENV] = "{not json";
	assert.equal(spinoffCreationRefusal([]), undefined, "malformed handshake grants nothing and elevates nothing");
	clean();
});

test("extension entry: root registers the Spinoff tools, a Subagent child none, a Spinoff child the same definitions that all refuse", async () => {
	const { default: spinoffExtension } = await import("../../src/index.ts");
	const load = () => {
		const tools = new Map<string, any>(), events: string[] = [];
		spinoffExtension({ registerTool: (t: any) => tools.set(t.name, t), registerMessageRenderer() {}, registerCommand() {}, on: (name: string) => events.push(name), getActiveTools: () => [] } as any);
		return { tools, events };
	};
	clean();
	const root = load();
	const ALL_TOOLS = [...SUBAGENT_TOOLS, ...SPINOFF_TOOLS].sort();
	assert.deepEqual([...root.tools.keys()].sort(), ALL_TOOLS, "one extension registers the subagent tools and spinoff");
	assert.ok(root.events.includes("turn_end"), "root owns Spinoffs");
	clean();
	process.env.PI_SUBAGENTS_GUARD = JSON.stringify({ id: "S", cwd: "/x", startupPath: "/y", shellMode: "foreground-v1" });
	assert.ok(!load().tools.has("spinoff"), "Subagent children register no Spinoff tool");
	clean();
	process.env[SPINOFF_GUARD_ENV] = JSON.stringify({ spinoffId: "F", token: "t" });
	const child = load();
	assert.deepEqual([...child.tools.keys()].sort(), ALL_TOOLS, "same tool list as the parent so the provider prefix matches");
	for (const name of ALL_TOOLS) {
		const a = root.tools.get(name), b = child.tools.get(name);
		assert.equal(b.description, a.description, `${name} description is identical`);
		assert.deepEqual(b.parameters, a.parameters, `${name} schema is identical`);
		if (name !== "subagent") assert.ok(a.outputSchema, `${name} declares an outputSchema`);
		assert.deepEqual(b.outputSchema, a.outputSchema, `${name} output schema is identical`);
		assert.equal(b.promptSnippet, a.promptSnippet, `${name} prompt snippet is identical`);
		assert.deepEqual(b.promptGuidelines, a.promptGuidelines, `${name} prompt guidelines are identical`);
		if (name === "spinoff" || name === "agent_message") await assert.rejects(() => b.execute("id", { task: "x", jobId: "J", message: "m" }, undefined, undefined, {}), /SPINOFF_FORBIDDEN/, `${name} is refused inside a Spinoff`);
	}
	assert.ok(!child.events.includes("turn_end"), "a Spinoff child owns no Spinoffs (no turn hook, no Spinoff store or Monitor provider)");
	clean();
});

test("the Spinoff child runs the host's own Pi script so both embed the same install paths in the system prompt", () => {
	const host = { execPath: "node", argv1: new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), packagedCli: () => "/pkg/cli.js" };
	assert.equal(getPiInvocation(["-x"], {}, host).args[0], "/pkg/cli.js", "Subagents keep resolving the package");
	assert.deepEqual(getPiInvocation(["-x"], {}, { ...host, preferHostScript: true }), { command: "node", args: [host.argv1, "-x"] });
	assert.equal(getPiInvocation(["-x"], {}, { ...host, argv1: "/does/not/exist.js", preferHostScript: true }).args[0], "/pkg/cli.js", "no host script on disk: fall back to the package");
});

test("Subagent argument builder excludes the Spinoff tools for new, resume and ready-query alike", () => {
	for (const persistence of [{ kind: "new" as const, sessionDir: "/d", sessionId: "S" }, { kind: "resume" as const, sessionDir: "/d", sessionFile: "/d/f.jsonl" }]) {
		for (const transport of ["json", "rpc"] as const) {
			const args = buildSubagentPiArgs({ persistence, transport, taskPath: "/t" });
			const excluded = args[args.indexOf("--exclude-tools") + 1]!.split(",");
			for (const name of ["subagent", "agent_status", "agent_cancel", "agent_message", ...SPINOFF_TOOLS]) assert.ok(excluded.includes(name), `${transport}/${persistence.kind} excludes ${name}`);
		}
	}
});

test("the Spinoff child excludes none of the tools: the Subagent group plus spinoff keep the parent's tool list", () => {
	assert.deepEqual([...SPINOFF_TOOLS], ["spinoff"], "agent_status, agent_cancel and agent_message are shared with Subagents (SUBAGENT_TOOLS)");
	const args = buildSpinoffPiArgs({ sessionPath: "/s/f.jsonl", sessionDir: "/s", model: "p/m", thinkingLevel: "high", tools: ["read", ...SUBAGENT_TOOLS, ...SPINOFF_TOOLS], trusted: true, guardPath: "/g.ts", forwarded: [] });
	assert.ok(!args.includes("--exclude-tools"), "the Spinoff child's tool list equals the parent's so it continues the cached prefix; calls are refused at execute time");
	assert.equal(args[args.indexOf("--tools") + 1], ["read", ...SUBAGENT_TOOLS, ...SPINOFF_TOOLS].join(","));
});

test("Spinoff child arguments: exact parent selection, nothing excluded, subagent kept, no task text", () => {
	const args = buildSpinoffPiArgs({ sessionPath: "/s/f.jsonl", sessionDir: "/s", model: "p/m", thinkingLevel: "high", tools: ["read", "subagent"], trusted: true, guardPath: "/g.ts", forwarded: ["-e", "/ext.ts"] });
	assert.ok(!args.includes("--exclude-tools"));
	assert.equal(args[args.indexOf("--tools") + 1], "read,subagent");
	assert.ok(args.includes("--approve") && !args.includes("--no-approve"));
	assert.deepEqual(args.slice(args.indexOf("--session"), args.indexOf("--session") + 2), ["--session", "/s/f.jsonl"]);
	assert.ok(args.includes("--mode") && args[args.indexOf("--mode") + 1] === "rpc");
	assert.deepEqual(buildSpinoffPiArgs({ sessionPath: "/s", sessionDir: "/d", model: "p/m", thinkingLevel: "off", tools: [], trusted: false, guardPath: "/g", forwarded: [] }).filter(a => a === "--no-tools" || a === "--no-approve"), ["--no-tools", "--no-approve"]);
});

test("parent resource flags are forwarded from a closed allow-list; inline prompt text goes to an owner-only file", () => {
	const dir = mkdtempSync(join(tmpdir(), "spinoff-args-"));
	try {
		mkdirSync(join(dir, ".pi", "spinoffs"), { recursive: true });
		const forwarded = forwardParentArgs(["--provider", "secretprov", "--api-key", "SECRET", "-e", "rel/ext.ts", "--no-skills", "--tools", "bash", "--session", "x", "--append-system-prompt", "INLINE TEXT", "--theme=dark.json", "-p"], dir, "JOB1", dir);
		assert.deepEqual(forwarded.args.slice(0, 3), ["-e", join(dir, "rel/ext.ts"), "--no-skills"]);
		assert.ok(!forwarded.args.some(a => a === "SECRET" || a === "secretprov" || a === "--tools" || a === "--session" || a === "-p"));
		const file = forwarded.args[forwarded.args.indexOf("--append-system-prompt") + 1]!;
		assert.equal(readFileSync(file, "utf8"), "INLINE TEXT");
		assert.ok(!forwarded.args.includes("INLINE TEXT"), "prompt text never sits on the command line");
		assert.equal(forwarded.temporaryFiles.length, 1);
		assert.deepEqual(forwarded.args.slice(-2), ["--theme", join(dir, "dark.json")]);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("snapshot: verbatim branch (compaction, images, opaque metadata), marker last, parent untouched, wx", () => {
	const dir = mkdtempSync(join(tmpdir(), "spinoff-snap-"));
	try {
		const sm = SessionManager.create(dir, join(dir, "s"));
		sm.appendMessage({ role: "user", content: [{ type: "text", text: "see" }, { type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: 1 } as never);
		sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "hm", textSignature: "OPAQUE" }], api: "a", provider: "p", model: "m", stopReason: "stop", timestamp: 2, responseId: "resp_1",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as never);
		const keep = sm.getLeafId()!;
		sm.appendCompaction("SUMMARY", keep, 10);
		sm.appendMessage({ role: "user", content: "after", timestamp: 3 } as never);
		const branch = sm.getBranch() as never as Array<Record<string, any>>;
		const before = readFileSync(sm.getSessionFile()!, "utf8");
		const written = writeSpinoffSession({ sessionId: sm.getSessionId(), sessionFile: sm.getSessionFile(), cwd: dir, sessionDir: join(dir, "s"), branch }, "JOBID", "01HZZZZZZZZZZZZZZZZZZZZZZ9");
		assert.equal(readFileSync(sm.getSessionFile()!, "utf8"), before, "source file byte-identical");
		const rows = readFileSync(written.sessionPath, "utf8").trim().split("\n").map(l => JSON.parse(l));
		assert.deepEqual(rows.slice(1, -1), branch.map(e => JSON.parse(JSON.stringify(e))), "entries copied verbatim in order");
		assert.ok(rows.some(r => r.type === "compaction"), "compaction preserved");
		assert.equal(rows.at(-1).customType, SPINOFF_MARKER_TYPE);
		assert.equal(rows[0].parentSession, sm.getSessionFile());
		const opened = SessionManager.open(written.sessionPath, join(dir, "s"));
		assert.equal(JSON.stringify(opened.getEntries().filter(e => e.type === "message")).includes("OPAQUE"), true);
		assert.equal(JSON.stringify(opened.getEntries()).includes("AAAA"), true, "image kept");
		assert.throws(() => writeSpinoffSession({ sessionId: "x", cwd: dir, sessionDir: join(dir, "s"), branch }, "J", "01HZZZZZZZZZZZZZZZZZZZZZZ9", new Date(written.sessionPath ? Date.parse(rows[0].timestamp) : 0)), /EEXIST|exists/);
		assert.equal(readdirSync(join(dir, "s")).length, 2);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("snapshot refuses unpaired tool calls instead of fabricating results", () => {
	const call = { id: "e1", parentId: null, type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "x", arguments: {} }] } };
	const result = { id: "e2", parentId: "e1", type: "message", message: { role: "toolResult", toolCallId: "c1" } };
	assert.deepEqual(unpairedToolCalls([call]), ["c1"]);
	assert.deepEqual(unpairedToolCalls([call, result]), []);
	assert.throws(() => writeSpinoffSession({ sessionId: "s", cwd: "/", sessionDir: "/nonexistent-never-created", branch: [call] }, "J", "S"), /SNAPSHOT_UNPAIRED_TOOL_CALLS/);
});

test("active-job bridge reports counts only for a valid scope and never exposes handles", () => {
	const scope = { sessionId: "S-bridge", cwd: "/w" };
	let shell = 2, valid = true;
	const revoke = publishCapability("shell_job", scope, 1, () => ({}), () => valid, () => shell);
	assert.deepEqual(activeJobCounts(scope), { shell: 2, subagents: 0 });
	shell = 0; assert.equal(activeJobCounts(scope).shell, 0);
	valid = false; shell = 5; assert.equal(activeJobCounts(scope).shell, 0, "invalid owner/generation reports nothing");
	valid = true; assert.equal(activeJobCounts({ ...scope, sessionId: "other" }).shell, 0);
	revoke(); assert.equal(activeJobCounts(scope).shell, 0);
});

test("Spinoff child allowlist adds the parent's unloaded deferred tools after the active ones, so tool_search there can load the same groups", () => {
	const args = buildSpinoffPiArgs({ sessionPath: "/s/f.jsonl", sessionDir: "/s", model: "p/m", thinkingLevel: "high", tools: ["read", "tool_search"], loadable: ["sqlite_open", "pty_spawn"], trusted: true, guardPath: "/g.ts", forwarded: [] });
	assert.equal(args[args.indexOf("--tools") + 1], "read,tool_search,sqlite_open,pty_spawn");
});
