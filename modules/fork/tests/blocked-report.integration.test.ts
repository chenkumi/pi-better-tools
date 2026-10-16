import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Regression for the reported failure: a Fork whose own model call was interrupted while one of its
// background jobs was still running stayed silently `running` for as long as that job lived, and
// fork_status showed nothing wrong. Real Pi CLI processes, offline deterministic provider, isolated
// HOME/agentDir/workspace, no credentials.
const here = dirname(fileURLToPath(import.meta.url));
const forkEntry = join(here, "../src/index.ts"), provider = join(here, "fixtures/provider.ts"), shellEntry = join(here, "../../shell-tools/src/index.ts");
const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle/cli.js");
const DEADLINE_MS = 120_000;

interface Run { events: any[]; stderr: string; code: number | null }
function isolated() {
	const root = mkdtempSync(join(tmpdir(), "pi-fork-blocked-"));
	const config = join(root, "config"), ws = join(root, "ws"), sessions = join(root, "sessions"), capture = join(root, "capture");
	for (const dir of [config, ws, sessions, capture]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(config, "auth.json"), "{}");
	writeFileSync(join(config, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off", defaultProjectTrust: "never" }));
	const env: Record<string, string> = {};
	for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "ProgramFiles", "ProgramFiles(x86)"]) if (process.env[key]) env[key] = process.env[key]!;
	Object.assign(env, { PI_FORK_DEBUG: "1", PI_CODING_AGENT_DIR: config, HOME: root, USERPROFILE: root, APPDATA: join(root, "appdata"), LOCALAPPDATA: join(root, "localappdata"),
		PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", FORK_CAPTURE: capture, FORK_SCENARIO: "interrupted" });
	return { root, ws, sessions, capture, env };
}

/** Drives one real RPC Pi; every wait is bound to a deadline and to process exit. */
function startPi(env: Record<string, string>, ws: string, sessions: string) {
	const args = [cli, "--mode", "rpc", "--offline", "--no-extensions", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "-e", forkEntry, "-e", provider, "-e", shellEntry,
		"--model", "fork-offline/m", "--thinking", "off", "--tools", "read,bash,fork,fork_status", "--session-dir", sessions];
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
	const deadline = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* gone */ } }, DEADLINE_MS * 2);
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
		async close(): Promise<Run> { clearTimeout(deadline); proc.stdin!.end(); const code = await Promise.race([exit, new Promise<null>(resolve => setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* gone */ } resolve(null); }, 20_000))]); return { events, stderr, code }; },
	};
}

const metaRecords = (ws: string) => {
	const dir = join(ws, ".pi", "forks"); let names: string[];
	try { names = readdirSync(dir).filter(n => n.endsWith(".json")); } catch { return []; }
	// Records are replaced atomically; a reader can lose the race on Windows, so a failed read means "not yet".
	return names.flatMap(name => { try { return [JSON.parse(readFileSync(join(dir, name), "utf8"))]; } catch { return []; } });
};
const forkFiles = (ws: string) => join(ws, ".pi", "forks");
/** Event-driven wait (fs.watch + deadline): no sleeps and no idle watchdog. */
function waitForState(ws: string, ready: () => boolean, name: string, context: () => string): Promise<void> {
	return new Promise((resolve, reject) => {
		if (ready()) { resolve(); return; }
		const finish = (error?: Error) => { clearTimeout(timer); watcher.close(); error ? reject(error) : resolve(); };
		const timer = setTimeout(() => finish(new Error(`deadline waiting for ${name}\n${context()}`)), DEADLINE_MS);
		timer.unref?.();
		const watcher = watch(ws, { recursive: true }, () => { if (ready()) finish(); });
	});
}
const notices = (events: any[]) => events.filter(e => e.type === "message_end" && e.message?.customType === "fork-result");
const toolResults = (events: any[], toolName: string) => events.filter(e => e.type === "message_end" && e.message?.role === "toolResult" && e.message.toolName === toolName);
const cleanup = async (root: string, parent?: ReturnType<typeof startPi>) => {
	// A blocked Fork keeps a detached child (and its background job) alive: kill the tree, not just the parent.
	if (parent) { try { spawn("taskkill", ["/PID", String(parent.proc.pid), "/T", "/F"], { windowsHide: true }); } catch { try { parent.proc.kill("SIGKILL"); } catch { /* gone */ } } await parent.exit.catch(() => undefined); }
	rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
};

test("real Pi: an interrupted Fork with an unfinished nested job is visible as blocked, never silently running", { timeout: DEADLINE_MS * 2 }, async () => {
	const iso = isolated();
	// The child's background job outlives the whole test: that is exactly the reported shape.
	writeFileSync(join(iso.ws, "blocked-job.mjs"), `setTimeout(() => {}, ${Number(process.env.FORK_JOB_MS ?? 600_000)});`);
	let parent: ReturnType<typeof startPi> | undefined;
	try {
		console.log("[progress] Starting real parent Pi (offline) for the blocked report");
		parent = startPi(iso.env, iso.ws, iso.sessions);
		parent.send({ id: "p1", type: "prompt", message: "DO_FORK interrupted" });
		const ctx = () => `records=${JSON.stringify(metaRecords(iso.ws))}\nstderr=${parent!.stderr()}`;
		await waitForState(iso.ws, () => metaRecords(iso.ws)[0]?.status === "blocked", "blocked report while the nested job runs", ctx);

		const meta = metaRecords(iso.ws)[0]!;
		assert.equal(meta.status, "blocked");
		assert.equal(meta.endedAt, undefined, "blocked is not terminal");
		assert.equal(meta.delivery, "pending");
		assert.equal(meta.blocked.reason, "MODEL_ERROR");
		assert.equal(meta.blocked.pending.shell >= 1, true, "the unfinished nested job is part of the report");
		assert.match(meta.blocked.error, /usage limit/);
		assert.equal(notices(parent.events).length, 0, "a still-running Fork must not claim a result");

		// What fork_status would actually tell the user: this used to show a healthy `running`.
		parent.send({ id: "p2", type: "prompt", message: "CHECK_STATUS please" });
		await parent.waitFor("fork_status result", events => toolResults(events, "fork_status").length > 0);
		const content = toolResults(parent.events, "fork_status")[0]!.message.content as Array<{ type: string; text: string }>;
		const reported = JSON.parse(content.find(part => part.type === "text")!.text);
		assert.equal(reported.forks[0].status, "blocked", "fork_status must not report a blocked Fork as healthy");
		assert.equal(reported.forks[0].blocked.reason, "MODEL_ERROR");
		assert.equal(reported.forks[0].blocked.pending.shell >= 1, true);

		// Quitting the parent must still cancel a blocked Fork and observe a real child close.
		const run = await parent.close();
		assert.equal(run.code, 0, run.stderr);
		const ended = metaRecords(iso.ws)[0]!;
		assert.equal(ended.cancelRequested, true);
		assert.equal(ended.status, "cancelled", "a blocked Fork is cancellable through the normal quit path");
		assert.equal(ended.cleanup.childClosed, true, "cancellation reports only an observed child close");
		assert.equal(notices(run.events).some(notice => notice.message.details.status === "completed"), false, "a cancelled Fork is never reported as completed");
	} finally { await cleanup(iso.root, parent); }
});

test("real Pi: the same interrupted Fork still finishes once its nested job ends", { timeout: DEADLINE_MS * 2 }, async () => {
	const iso = isolated();
	writeFileSync(join(iso.ws, "blocked-job.mjs"), "setTimeout(() => {}, 6000);");
	let parent: ReturnType<typeof startPi> | undefined;
	try {
		console.log("[progress] Starting real parent Pi (offline) for blocked -> recovery");
		parent = startPi({ ...iso.env, FORK_JOB_MS: "6000" }, iso.ws, iso.sessions);
		parent.send({ id: "p1", type: "prompt", message: "DO_FORK interrupted" });
		const ctx = () => `records=${JSON.stringify(metaRecords(iso.ws))}\nstderr=${parent!.stderr()}`;
		await waitForState(iso.ws, () => metaRecords(iso.ws)[0]?.status === "blocked", "blocked report before the job ends", ctx);
		await waitForState(iso.ws, () => metaRecords(iso.ws)[0]?.status === "failed", "terminal failure after the job ended", ctx);
		const meta = metaRecords(iso.ws)[0]!;
		assert.equal(meta.result.errorCode, "CHILD_MODEL_ERROR", "the model error is still reported as the outcome");
		assert.equal(meta.blocked, undefined, "the blocked truth must not survive recovery");
		assert.equal(meta.cleanup.childClosed, true);
		await parent.waitFor("fork result notice", events => notices(events).length > 0);
		const run = await parent.close();
		assert.equal(run.code, 0, run.stderr);
		assert.equal(notices(run.events)[0]!.message.details.status, "failed");
	} finally { await cleanup(iso.root, parent); }
});
