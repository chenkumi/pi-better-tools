import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { watch } from "node:fs";

// Real Pi 1.1.0 CLI processes, offline deterministic provider, isolated HOME/agentDir/workspace. No real credentials.
const here = dirname(fileURLToPath(import.meta.url));
const forkEntry = join(here, "../src/index.ts"), provider = join(here, "fixtures/provider.ts");
const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle/cli.js");
const DEADLINE_MS = 120_000;

interface Run { events: any[]; stderr: string; code: number | null; stdin: ChildProcess["stdin"] }
function isolated() {
	const root = mkdtempSync(join(tmpdir(), "pi-fork-it-"));
	const config = join(root, "config"), ws = join(root, "ws"), sessions = join(root, "sessions"), capture = join(root, "capture");
	for (const dir of [config, ws, sessions, capture]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(config, "auth.json"), "{}");
	writeFileSync(join(config, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off", defaultProjectTrust: "never" }));
	const env: Record<string, string> = {};
	for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "ProgramFiles", "ProgramFiles(x86)"]) if (process.env[key]) env[key] = process.env[key]!;
	Object.assign(env, { PI_FORK_DEBUG: "1", PI_CODING_AGENT_DIR: config, HOME: root, USERPROFILE: root, APPDATA: join(root, "appdata"), LOCALAPPDATA: join(root, "localappdata"), PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", FORK_CAPTURE: capture });
	return { root, ws, sessions, capture, env };
}

/** Drives one real RPC Pi. Every wait is bound to the single deadline and to process exit. */
function startPi(env: Record<string, string>, ws: string, sessions: string, extra: string[], tools: string | null = "read,fork,fork_status") {
	const args = [cli, "--mode", "rpc", "--offline", "--no-extensions", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "-e", forkEntry, "-e", provider,
		"--model", "fork-offline/m", "--thinking", "off", ...(tools === null ? [] : ["--tools", tools]), "--session-dir", sessions, ...extra];
	const proc = spawn(process.execPath, args, { cwd: ws, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
	const events: any[] = []; let stderr = "", buffer = "";
	const waiters: Array<{ test: (events: any[]) => boolean; resolve: () => void }> = [];
	const exit = new Promise<number | null>(resolve => proc.once("close", resolve));
	proc.stderr!.on("data", chunk => { stderr = (stderr + chunk).slice(-16384); });
	proc.stdout!.setEncoding("utf8");
	proc.stdout!.on("data", (chunk: string) => {
		buffer += chunk;
		for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
			const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
			try { events.push(JSON.parse(line)); } catch { continue; }
		}
		for (const waiter of [...waiters]) if (waiter.test(events)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(); }
	});
	const deadline = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* gone */ } }, DEADLINE_MS);
	return {
		proc, events, exit,
		stderr: () => stderr,
		send: (message: Record<string, unknown>) => proc.stdin!.write(JSON.stringify(message) + "\n"),
		waitFor: (name: string, test: (events: any[]) => boolean) => new Promise<void>((resolve, reject) => {
			if (test(events)) { resolve(); return; }
			waiters.push({ test, resolve });
			exit.then(code => reject(new Error(`Pi exited (${code}) while waiting for ${name}\n${stderr}`)));
			setTimeout(() => reject(new Error(`deadline waiting for ${name}`)), DEADLINE_MS).unref();
		}),
		async close(): Promise<Run> { clearTimeout(deadline); proc.stdin!.end(); const code = await Promise.race([exit, new Promise<null>(resolve => setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* gone */ } resolve(null); }, 20_000))]); return { events, stderr, code, stdin: null }; },
	};
}
const jsonl = (path: string) => readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
const customResults = (events: any[]) => events.filter(e => e.type === "message_end" && e.message?.customType === "fork-result");
const sessionFiles = (dir: string) => readdirSync(dir).filter(name => name.endsWith(".jsonl")).map(name => join(dir, name));

test("real Pi: fork snapshot, independent child, report back, cold /resume stays non-forkable", { timeout: DEADLINE_MS * 2 }, async () => {
	const iso = isolated();
	let parent: ReturnType<typeof startPi> | undefined;
	try {
		console.log("[progress] Starting real parent Pi (RPC, offline)");
		parent = startPi(iso.env, iso.ws, iso.sessions, [], null);
		parent.send({ id: "p1", type: "prompt", message: "DO_FORK please" });
		await parent.waitFor("fork result notice", events => customResults(events).length > 0);
		console.log("[progress] Fork result observed; waiting for the parent's follow-up turn to settle");
		await parent.waitFor("settle after notice", events => {
			const at = events.findIndex(e => e.type === "message_end" && e.message?.customType === "fork-result");
			return at >= 0 && events.slice(at).some(e => e.type === "agent_settled");
		});
		const run = await parent.close();
		assert.equal(run.code, 0, run.stderr);
		const result = customResults(run.events);
		assert.equal(result.length, 1, "exactly one result notice");
		const details = result[0].message.details;
		assert.equal(details.status, "completed");
		assert.match(result[0].message.content, /FORK_CHILD_DONE/);
		assert.match(details.forkSessionId, /^[0-9A-HJKMNP-TV-Z]{26}$/);

		const [parentFile, forkFile] = (() => { const files = sessionFiles(iso.sessions); const fork = files.find(f => f.includes(details.forkSessionId))!; return [files.find(f => f !== fork)!, fork]; })();
		const forkEntries = jsonl(forkFile);
		assert.equal(forkEntries[0].type, "session");
		assert.equal(forkEntries[0].id, details.forkSessionId);
		assert.equal(forkEntries[0].parentSession, parentFile);
		const marker = forkEntries.find(e => e.type === "custom" && e.customType === "pi-better-tools.fork-origin");
		assert.ok(marker, "persisted fork origin marker");
		assert.equal(marker.data.role, "fork");
		// Native /resume discovery uses SessionManager.list over the effective session directory.
		const listed = await SessionManager.list(iso.ws, iso.sessions);
		assert.ok(listed.some(info => info.id === details.forkSessionId && info.path === forkFile), "Fork conversation is discoverable by native session listing");
		const parentEntries = jsonl(parentFile);
		assert.equal(parentEntries.filter(e => e.type === "custom_message" && e.customType === "fork-result").length, 1, "result journalled in the parent only");
		assert.ok(!forkEntries.some(e => e.type === "custom_message" && e.customType === "fork-result"), "parent's later notice must not appear in the fork");
		// The snapshot is the exact parent branch up to the tool result, never a fabricated one.
		const copied = forkEntries.filter(e => e.type === "message" && e.message.role !== "system").slice(0, 3);
		assert.deepEqual(copied.map(e => e.message.role), ["user", "assistant", "toolResult"]);
		assert.equal(copied[2].message.toolCallId, "fork-call-1");

		const requests = readdirSync(iso.capture).map(name => JSON.parse(readFileSync(join(iso.capture, name), "utf8")));
		const child = requests.filter(r => r.isChild), root = requests.filter(r => !r.isChild);
		assert.ok(child.length >= 1 && root.length >= 2);
		assert.ok(!child.some(r => r.pid === root[0].pid), "child is a separate process");
		assert.ok(root[0].tools.includes("fork") && root[0].tools.includes("read"));
		for (const name of ["fork", "fork_status", "fork_cancel"]) assert.ok(root[0].tools.includes(name), `${name} is active without --tools or defaultTools`);
		assert.deepEqual([...child[0].tools].sort(), root[0].tools.filter((name: string) => !["fork", "fork_status", "fork_cancel"].includes(name)).sort(), "child inherits the exact parent selection minus Fork tools");
		assert.ok(JSON.stringify(child[0].messages).includes("DO_FORK please"), "child sees the inherited conversation");
		assert.equal(child[0].roles.at(-1), "user");

		const metaDir = join(iso.ws, ".pi", "forks");
		const [metaName] = readdirSync(metaDir).filter(n => n.endsWith(".json"));
		const meta = JSON.parse(readFileSync(join(metaDir, metaName!), "utf8"));
		assert.equal(meta.status, "completed");
		assert.equal(meta.delivery, "observed");
		assert.equal(meta.cleanup.childClosed, true);
		assert.ok(!JSON.stringify(meta).includes("offline-dummy"));
		// The query transcript lives in its own directory next to the metadata; only finalized files may remain.
		assert.deepEqual(readdirSync(metaDir).filter(n => !n.endsWith(".json")), [meta.jobId], "no leftover temp files beside the Fork's transcript directory");
		assert.deepEqual(readdirSync(join(metaDir, meta.jobId)), ["transcript.jsonl"], "finalized transcript only, no .partial");

		// Cold /resume of the Fork conversation in a root Pi that has the Fork tool selected: creation stays refused.
		console.log("[progress] Cold-resuming the fork conversation");
		const resumed = startPi(iso.env, iso.ws, iso.sessions, ["--session", forkFile]);
		try {
			resumed.send({ id: "r1", type: "prompt", message: "DO_FORK again" });
			await resumed.waitFor("refused tool result", events => events.some(e => e.type === "message_end" && e.message?.role === "toolResult" && e.message.toolName === "fork"));
			await resumed.waitFor("settled", events => events.some(e => e.type === "agent_settled"));
		} finally { await resumed.close(); }
		const refused = resumed.events.find(e => e.type === "message_end" && e.message?.role === "toolResult" && e.message.toolName === "fork").message;
		assert.equal(refused.isError, true);
		assert.match(JSON.stringify(refused.content), /FORK_FORBIDDEN/);
		assert.equal(sessionFiles(iso.sessions).length, 2, "refusal created no extra native session");
	} finally {
		if (parent) { try { parent.proc.kill("SIGKILL"); } catch { /* gone */ } await parent.exit.catch(() => undefined); }
		rmSync(iso.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
		assert.equal(existsSync(iso.root), false);
	}
});

const shellEntry = join(here, "../../shell-tools/src/index.ts"), subagentsEntry = join(here, "../../subagents/src/index.ts");
/** Event-driven (fs.watch) wait with its own deadline: no sleeps, no idle watchdog. */
function waitForDir(dir: string, ready: () => boolean, name: string): Promise<void> {
	return new Promise((resolve, reject) => {
		if (ready()) { resolve(); return; }
		const timer = setTimeout(() => { watcher.close(); reject(new Error(`deadline waiting for ${name}`)); }, DEADLINE_MS);
		const watcher = watch(dir, { recursive: true }, () => { if (ready()) { clearTimeout(timer); watcher.close(); resolve(); } });
	});
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const capturedRequests = (dir: string) => readdirSync(dir).filter(n => n.endsWith(".json")).map(n => JSON.parse(readFileSync(join(dir, n), "utf8")));
const metaRecords = (ws: string) => {
	const dir = join(ws, ".pi", "forks"); let names: string[];
	try { names = readdirSync(dir).filter(n => n.endsWith(".json")); } catch { return []; }
	// The Fork replaces these files atomically; a reader can transiently lose the race on Windows, so a failed read is "not yet".
	return names.flatMap(n => { try { return [JSON.parse(readFileSync(join(dir, n), "utf8"))]; } catch { return []; } });
};

test("real Pi: Fork waits for its own background shell job and can use the subagent tool but not Fork", { timeout: DEADLINE_MS * 2 }, async () => {
	const iso = isolated();
	writeFileSync(join(iso.ws, "nested-job.mjs"), "import { writeFileSync } from 'node:fs'; setTimeout(() => writeFileSync('nested.marker', 'done'), 2500);");
	const parent = startPi({ ...iso.env, FORK_SCENARIO: "nested-shell" }, iso.ws, iso.sessions, ["-e", shellEntry, "-e", subagentsEntry], "read,bash,subagent,fork");
	try {
		parent.send({ id: "p1", type: "prompt", message: "DO_FORK nested" });
		await parent.waitFor("fork result notice", events => customResults(events).length > 0);
		await parent.waitFor("settle after notice", events => events.slice(events.findIndex(e => e.message?.customType === "fork-result")).some(e => e.type === "agent_settled"));
		const run = await parent.close();
		assert.equal(run.code, 0, run.stderr);
		const notice = customResults(run.events)[0].message;
		assert.equal(notice.details.status, "completed");
		assert.match(notice.content, /NESTED_JOB_OBSERVED/, "result is the post-job answer, not the early settle");
		assert.ok(!notice.content.includes("FORK_CHILD_SETTLED_EARLY"), "early-settle text is not the reported result");
		assert.equal(existsSync(join(iso.ws, "nested.marker")), true, "nested job finished before the Fork was reported");
		const child = capturedRequests(iso.capture).filter(r => r.isChild).sort((a, b) => a.nth - b.nth);
		assert.ok(child.length >= 3, "initial turn, early settle turn, and the job wake-up turn");
		assert.deepEqual([...child[0].tools].sort(), ["bash", "read", "subagent"], "Fork keeps the parent's subagent selection and loses only Fork tools");
		assert.ok(!child[0].tools.some((name: string) => name.startsWith("fork")));
		const [meta] = metaRecords(iso.ws);
		assert.equal(meta.status, "completed"); assert.equal(meta.cleanup.childClosed, true);
	} finally { try { parent.proc.kill("SIGKILL"); } catch { /* gone */ } await parent.exit.catch(() => undefined); rmSync(iso.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});

test("real Pi: Fork survives A->new->A, reports only to its origin session", { timeout: DEADLINE_MS * 2 }, async () => {
	const iso = isolated();
	const parent = startPi({ ...iso.env, FORK_SCENARIO: "gated" }, iso.ws, iso.sessions, []);
	try {
		parent.send({ id: "p1", type: "prompt", message: "DO_FORK gated" });
		await waitForDir(iso.capture, () => capturedRequests(iso.capture).some(r => r.isChild), "gated child request");
		await parent.waitFor("origin settled", events => events.some(e => e.type === "agent_settled"));
		const originFile = sessionFiles(iso.sessions).find(f => !f.includes(metaRecords(iso.ws)[0].forkSessionId))!;
		parent.send({ id: "n1", type: "new_session" });
		await parent.waitFor("new_session response", events => events.some(e => e.type === "response" && e.id === "n1"));
		assert.equal(customResults(parent.events).length, 0, "nothing delivered while the child still runs");
		writeFileSync(join(iso.capture, "release"), "go");
		await waitForDir(join(iso.ws, ".pi", "forks"), () => metaRecords(iso.ws)[0]?.status === "completed", "child completion while in session B").catch(error => {
			throw new Error(`${error.message}
records=${JSON.stringify(metaRecords(iso.ws))}
stderr=${parent.stderr()}
captured=${readdirSync(iso.capture).join(",")}
last events=${parent.events.slice(-12).map(e => e.type + (e.message?.customType ? ":" + e.message.customType : "")).join(" ")}`);
		});
		assert.equal(customResults(parent.events).length, 0, "completion in B is not injected into B");
		assert.equal(metaRecords(iso.ws)[0].delivery, "pending");
		parent.send({ id: "s1", type: "switch_session", sessionPath: originFile });
		await parent.waitFor("result delivered after switching back", events => customResults(events).length > 0);
		await parent.waitFor("follow-up settle", events => events.slice(events.findIndex(e => e.message?.customType === "fork-result")).some(e => e.type === "agent_settled"));
		const run = await parent.close();
		assert.equal(run.code, 0, run.stderr);
		assert.equal(customResults(run.events).length, 1);
		const files = sessionFiles(iso.sessions);
		const withNotice = files.filter(f => jsonl(f).some(e => e.type === "custom_message" && e.customType === "fork-result"));
		assert.deepEqual(withNotice, [originFile], "only the origin journal has the notice");
		assert.equal(metaRecords(iso.ws)[0].delivery, "observed");
	} finally { try { parent.proc.kill("SIGKILL"); } catch { /* gone */ } await parent.exit.catch(() => undefined); rmSync(iso.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});

test("real Pi: quitting the parent cancels an unfinished Fork and the child process closes", { timeout: DEADLINE_MS * 2 }, async () => {
	const iso = isolated();
	const parent = startPi({ ...iso.env, FORK_SCENARIO: "gated" }, iso.ws, iso.sessions, []);
	try {
		parent.send({ id: "p1", type: "prompt", message: "DO_FORK gated" });
		await waitForDir(iso.capture, () => capturedRequests(iso.capture).some(r => r.isChild), "gated child request");
		const childPid = capturedRequests(iso.capture).find(r => r.isChild).pid as number;
		assert.equal(alive(childPid), true);
		await parent.waitFor("origin settled", events => events.some(e => e.type === "agent_settled"));
		const run = await parent.close(); // stdin EOF = graceful quit: session_shutdown(quit) fans cancellation out
		assert.equal(run.code, 0, run.stderr);
		const [meta] = metaRecords(iso.ws);
		assert.equal(meta.status, "cancelled");
		assert.equal(meta.cancelRequested, true);
		assert.equal(meta.cleanup.childClosed, true, "a real child close was observed before the parent exited");
		assert.equal(alive(childPid), false);
	} finally { try { parent.proc.kill("SIGKILL"); } catch { /* gone */ } await parent.exit.catch(() => undefined); rmSync(iso.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});
