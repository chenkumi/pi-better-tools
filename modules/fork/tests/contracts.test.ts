import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { buildSubagentPiArgs } from "../../subagents/extensions/subagent/child-args.ts";
import { activeJobCounts, publishCapability } from "../../shell-tools/src/monitor-capability.ts";
import { forwardParentArgs } from "../src/args.ts";
import { buildForkPiArgs } from "../src/child.ts";
import { FORK_GUARD_ENV, FORK_MARKER_TYPE, FORK_TOOLS, forkCreationRefusal } from "../src/identity.ts";
import { unpairedToolCalls, writeForkSession } from "../src/snapshot.ts";

const SLOT = Symbol.for("pi-better-tools.fork.child-guard.v1");
const MANAGED = "__piSubagentsGuardExpected";
const clean = () => { delete (globalThis as any)[SLOT]; delete (globalThis as any)[MANAGED]; delete process.env[FORK_GUARD_ENV]; delete process.env.PI_SUBAGENTS_GUARD; };

test("role matrix: only a root session may create a Fork; trusted startup data decides, not arguments", () => {
	clean();
	assert.equal(forkCreationRefusal([]), undefined, "root");
	assert.match(forkCreationRefusal([{ type: "custom", customType: FORK_MARKER_TYPE }])!, /itself a Fork/, "cold-resumed Fork conversation");
	assert.equal(forkCreationRefusal([{ type: "custom", customType: "something-else" }]), undefined);
	process.env[FORK_GUARD_ENV] = JSON.stringify({ forkId: "F", token: "t" });
	assert.match(forkCreationRefusal([])!, /Fork process/, "Fork child via startup handshake");
	assert.equal(process.env[FORK_GUARD_ENV], undefined, "handshake is consumed so descendants never inherit it");
	assert.match(forkCreationRefusal([])!, /Fork process/, "identity survives reload within the process");
	clean();
	process.env.PI_SUBAGENTS_GUARD = JSON.stringify({ id: "S", cwd: "/x", startupPath: "/y", shellMode: "foreground-v1" });
	assert.match(forkCreationRefusal([])!, /Subagent/, "Subagent managed child");
	clean();
	process.env[FORK_GUARD_ENV] = "{not json";
	assert.equal(forkCreationRefusal([]), undefined, "malformed handshake grants nothing and elevates nothing");
	clean();
});

test("Subagent argument builder excludes the Fork tools for new, resume and ready-query alike", () => {
	for (const persistence of [{ kind: "new" as const, sessionDir: "/d", sessionId: "S" }, { kind: "resume" as const, sessionDir: "/d", sessionFile: "/d/f.jsonl" }]) {
		for (const transport of ["json", "rpc"] as const) {
			const args = buildSubagentPiArgs({ persistence, transport, taskPath: "/t" });
			const excluded = args[args.indexOf("--exclude-tools") + 1]!.split(",");
			for (const name of ["subagent", "subagent_status", "subagent_cancel", "subagent_message", ...FORK_TOOLS]) assert.ok(excluded.includes(name), `${transport}/${persistence.kind} excludes ${name}`);
		}
	}
});

test("Fork child arguments: exact parent selection, only Fork tools excluded, subagent NOT excluded, no task text", () => {
	const args = buildForkPiArgs({ sessionPath: "/s/f.jsonl", sessionDir: "/s", model: "p/m", thinkingLevel: "high", tools: ["read", "subagent"], trusted: true, guardPath: "/g.ts", forwarded: ["-e", "/ext.ts"] });
	assert.equal(args[args.indexOf("--exclude-tools") + 1], FORK_TOOLS.join(","));
	assert.ok(!args.join(" ").includes("subagent,subagent_status"));
	assert.equal(args[args.indexOf("--tools") + 1], "read,subagent");
	assert.ok(args.includes("--approve") && !args.includes("--no-approve"));
	assert.deepEqual(args.slice(args.indexOf("--session"), args.indexOf("--session") + 2), ["--session", "/s/f.jsonl"]);
	assert.ok(args.includes("--mode") && args[args.indexOf("--mode") + 1] === "rpc");
	assert.deepEqual(buildForkPiArgs({ sessionPath: "/s", sessionDir: "/d", model: "p/m", thinkingLevel: "off", tools: [], trusted: false, guardPath: "/g", forwarded: [] }).filter(a => a === "--no-tools" || a === "--no-approve"), ["--no-tools", "--no-approve"]);
});

test("parent resource flags are forwarded from a closed allow-list; inline prompt text goes to an owner-only file", () => {
	const dir = mkdtempSync(join(tmpdir(), "fork-args-"));
	try {
		mkdirSync(join(dir, ".pi", "forks"), { recursive: true });
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
	const dir = mkdtempSync(join(tmpdir(), "fork-snap-"));
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
		const written = writeForkSession({ sessionId: sm.getSessionId(), sessionFile: sm.getSessionFile(), cwd: dir, sessionDir: join(dir, "s"), branch }, "JOBID", "01HZZZZZZZZZZZZZZZZZZZZZZ9");
		assert.equal(readFileSync(sm.getSessionFile()!, "utf8"), before, "source file byte-identical");
		const rows = readFileSync(written.sessionPath, "utf8").trim().split("\n").map(l => JSON.parse(l));
		assert.deepEqual(rows.slice(1, -1), branch.map(e => JSON.parse(JSON.stringify(e))), "entries copied verbatim in order");
		assert.ok(rows.some(r => r.type === "compaction"), "compaction preserved");
		assert.equal(rows.at(-1).customType, FORK_MARKER_TYPE);
		assert.equal(rows[0].parentSession, sm.getSessionFile());
		const opened = SessionManager.open(written.sessionPath, join(dir, "s"));
		assert.equal(JSON.stringify(opened.getEntries().filter(e => e.type === "message")).includes("OPAQUE"), true);
		assert.equal(JSON.stringify(opened.getEntries()).includes("AAAA"), true, "image kept");
		assert.throws(() => writeForkSession({ sessionId: "x", cwd: dir, sessionDir: join(dir, "s"), branch }, "J", "01HZZZZZZZZZZZZZZZZZZZZZZ9", new Date(written.sessionPath ? Date.parse(rows[0].timestamp) : 0)), /EEXIST|exists/);
		assert.equal(readdirSync(join(dir, "s")).length, 2);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("snapshot refuses unpaired tool calls instead of fabricating results", () => {
	const call = { id: "e1", parentId: null, type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "x", arguments: {} }] } };
	const result = { id: "e2", parentId: "e1", type: "message", message: { role: "toolResult", toolCallId: "c1" } };
	assert.deepEqual(unpairedToolCalls([call]), ["c1"]);
	assert.deepEqual(unpairedToolCalls([call, result]), []);
	assert.throws(() => writeForkSession({ sessionId: "s", cwd: "/", sessionDir: "/nonexistent-never-created", branch: [call] }, "J", "S"), /SNAPSHOT_UNPAIRED_TOOL_CALLS/);
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
