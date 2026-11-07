import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AGENT_TIMEOUT_MS, runAgentJob, type ChildSession } from "../src/agent-run.ts";
import { CommandApprovals, resolveCwd } from "../src/cwd.ts";
import { createExecutor } from "../src/executor.ts";
import { shellProblem } from "../src/guard.ts";
import { MARKER_TYPE, type MarkerDetails } from "../src/markers.ts";
import { runPromptJob } from "../src/prompt-run.ts";
import { runShellJob, type ExecFn, type ProcessEvents } from "../src/shell-run.ts";
import { TailBuffer } from "../src/tail.ts";
import { makeJob, ManualClock } from "./helpers.ts";

const info = { scheduledFor: "2030-01-01T00:00:00.000Z" };

function fakePi(active: string[] = ["bash", "powershell"]) {
	const messages: Array<{ message: { customType: string; content: unknown[]; details: MarkerDetails }; options: Record<string, unknown> }> = [];
	const users: Array<{ text: string; options: unknown }> = [];
	return {
		messages, users,
		sendMessage: (message: never, options: never) => { messages.push({ message, options }); },
		sendUserMessage: (text: string, options: unknown) => { users.push({ text, options }); },
		getActiveTools: () => active,
		getSettings: () => ({}),
		phases: () => messages.map((m) => m.message.details.phase),
	};
}

const dir = () => { const root = mkdtempSync(join(tmpdir(), "sc-run-")); return { root, done: () => rmSync(root, { recursive: true, force: true }) }; };

/** An exec double whose process is driven by the test through `events`. */
function controlledExec() {
	const state: { events?: ProcessEvents; signal?: AbortSignal; cwd?: string; tool?: string; finish?: () => void; command?: string } = {};
	const exec: ExecFn = (tool, command, signal, events, options) => {
		Object.assign(state, { events, signal, cwd: options.cwd, tool, command });
		return new Promise<void>((resolve) => {
			state.finish = resolve;
			signal.addEventListener("abort", () => { events.closed(null, "SIGTERM", false); resolve(); }, { once: true });
		});
	};
	return { exec, state };
}

function shellSetup(over: { active?: string[]; cwd?: string; approvals?: CommandApprovals; tailBytes?: number } = {}) {
	const pi = fakePi(over.active);
	const clock = new ManualClock();
	const control = controlledExec();
	const d = dir();
	const approvals = over.approvals ?? new CommandApprovals();
	const active = new Set<AbortController>();
	const deps = { pi, clock, exec: control.exec, projectCwd: () => over.cwd ?? d.root, activeTools: () => pi.getActiveTools(), approvals, tailBytes: over.tailBytes ?? 8192, active };
	return { pi, clock, control, d, deps, active, approvals };
}

test("shell: success posts start and done markers, output stays in details and the model sees nothing", async () => {
	const s = shellSetup();
	try {
		const run = runShellJob(s.deps, makeJob({ kind: "shell", command: "echo hi", shell: "bash" }) as never, info);
		await s.clock.settle();
		s.control.state.events!.started();
		assert.equal(await run.started, true);
		s.control.state.events!.stdout(Buffer.from("hello\n"));
		s.control.state.events!.closed(0, null, false);
		s.control.state.finish!();
		assert.deepEqual(await run.done, { status: "success" });
		assert.deepEqual(s.pi.phases(), ["start", "done"]);
		assert.equal(s.pi.messages[1].message.details.output, "hello");
		assert.ok(s.pi.messages.every((m) => m.message.customType === MARKER_TYPE && m.message.content.length === 0 && m.options.triggerTurn === false));
		assert.equal(s.active.size, 0);
	} finally { s.d.done(); }
});

test("shell: a non-zero exit is an error that carries the output tail", async () => {
	const s = shellSetup();
	try {
		const run = runShellJob(s.deps, makeJob({ kind: "shell", command: "false", shell: "bash" }) as never, info);
		await s.clock.settle();
		s.control.state.events!.stderr(Buffer.from("boom"));
		s.control.state.events!.closed(3, null, false);
		s.control.state.finish!();
		const outcome = await run.done;
		assert.equal(outcome.status, "error");
		assert.match(outcome.error!, /^command exited with code 3\nboom/);
		assert.equal(s.pi.messages.at(-1)!.message.details.exitCode, 3);
	} finally { s.d.done(); }
});

test("shell: timeoutMs is an output-stall limit, renewed by every chunk", async () => {
	const s = shellSetup();
	try {
		const run = runShellJob(s.deps, makeJob({ kind: "shell", command: "slow", shell: "bash", timeoutMs: 1000 }) as never, info);
		await s.clock.settle();
		await s.clock.advance(900);
		s.control.state.events!.stdout(Buffer.from("tick"));
		await s.clock.advance(900);
		assert.equal(s.control.state.signal!.aborted, false, "output restarted the stall timer");
		await s.clock.advance(100);
		assert.equal(s.control.state.signal!.aborted, true);
		const outcome = await run.done;
		assert.match(outcome.error!, /no output for 1000 ms and was stopped; cancellation was only requested/);
	} finally { s.d.done(); }
});

test("shell: the shell tool must be enabled, and there is no fallback to the other shell", async () => {
	const s = shellSetup({ active: ["powershell"] });
	try {
		const run = runShellJob(s.deps, makeJob({ kind: "shell", command: "x", shell: "bash" }) as never, info);
		const outcome = await run.done;
		assert.equal(await run.started, false);
		assert.match(outcome.error!, /shell: "bash" needs the bash tool to be enabled/);
		assert.equal(s.control.state.events, undefined, "nothing was started");
		assert.deepEqual(s.pi.phases(), ["error"]);
		assert.equal(shellProblem(["bash"], "bash"), undefined);
	} finally { s.d.done(); }
});

test("shell: a directory outside the project runs only after an in-process approval", async () => {
	const outside = dir(), project = dir();
	try {
		const approvals = new CommandApprovals();
		const s = shellSetup({ cwd: project.root, approvals });
		const job = makeJob({ kind: "shell", command: "ls", shell: "bash", cwd: outside.root }) as never;
		const refused = await runShellJob(s.deps, job, info).done;
		assert.match(refused.error!, /outside the project and was not approved/);
		assert.equal(s.control.state.events, undefined);
		approvals.approve("ls", "bash", resolveCwd(project.root, outside.root).ok ? (resolveCwd(project.root, outside.root) as { cwd: string }).cwd : "");
		const run = runShellJob(s.deps, job, info);
		await s.clock.settle();
		assert.ok(s.control.state.events, "approved: it ran");
		(s.control.state.events as ProcessEvents).closed(0, null, false);
		s.control.state.finish!();
		assert.equal((await run.done).status, "success");
	} finally { outside.done(); project.done(); }
});

test("shell: a missing cwd is refused and there is no fallback directory", async () => {
	const s = shellSetup();
	try {
		const outcome = await runShellJob(s.deps, makeJob({ kind: "shell", command: "x", shell: "bash", cwd: "nope" }) as never, info).done;
		assert.match(outcome.error!, /cwd: "nope" does not exist/);
		assert.equal(s.control.state.events, undefined);
	} finally { s.d.done(); }
});

test("shell: cancellation by shutdown ends the run without markers after the start", async () => {
	const s = shellSetup();
	try {
		const run = runShellJob(s.deps, makeJob({ kind: "shell", command: "long", shell: "bash" }) as never, info);
		await s.clock.settle();
		for (const controller of [...s.active]) controller.abort();
		const outcome = await run.done;
		assert.match(outcome.error!, /cancelled because the session ended; cancellation was only requested/);
		assert.deepEqual(s.pi.phases(), ["start"]);
	} finally { s.d.done(); }
});

test("prompt: a display marker, then a follow-up user message", async () => {
	const pi = fakePi();
	const run = runPromptJob(pi as never, makeJob({ prompt: "check the build" }) as never, { ...info, missed: 2 });
	assert.deepEqual(await run.done, { status: "success" });
	assert.deepEqual(pi.users, [{ text: "check the build", options: { deliverAs: "followUp" } }]);
	assert.equal(pi.messages[0].message.details.catchUp, 2);
	assert.equal(pi.messages[0].message.content.length, 0);
	const failing = { ...pi, sendUserMessage: () => { throw new Error("stale"); } };
	assert.equal((await runPromptJob(failing as never, makeJob() as never, info).done).error, "stale");
});

function fakeChild(behaviour: { text?: string; failure?: string; throws?: string; cleanup?: string; hang?: boolean }) {
	const state = { aborted: false, disposed: false };
	let release!: () => void;
	const child: ChildSession = {
		async run() {
			if (behaviour.throws) throw new Error(behaviour.throws);
			if (behaviour.hang) await new Promise<void>((resolve) => { release = resolve; state.aborted ||= false; });
			return { text: behaviour.text ?? "done", ...(behaviour.failure ? { failure: behaviour.failure } : {}) };
		},
		abort() { state.aborted = true; release?.(); },
		async dispose() { state.disposed = true; return behaviour.cleanup; },
	};
	return { child, state };
}

function agentSetup(behaviour: Parameters<typeof fakeChild>[0], notify?: boolean) {
	const pi = fakePi();
	const clock = new ManualClock();
	const fake = fakeChild(behaviour);
	const active = new Set<AbortController>();
	const job = makeJob({ kind: "agent", prompt: "summarise", model: "m1", ...(notify !== undefined ? { notify } : {}) }) as never;
	const run = runAgentJob({ pi, clock, createChild: async () => fake.child, active }, job, info);
	return { pi, clock, fake, run, active };
}

test("agent: success without notify never wakes the main agent; the start marker has text", async () => {
	const s = agentSetup({ text: "all good" });
	assert.equal(await s.run.started, true);
	assert.deepEqual(await s.run.done, { status: "success" });
	assert.ok(s.pi.messages[0].message.content.length > 0, "start marker is not empty");
	assert.ok(s.pi.messages.every((m) => m.options.triggerTurn !== true));
	assert.equal(s.pi.messages.at(-1)!.message.details.output, "all good");
	assert.equal(s.fake.state.disposed, true);
});

test("agent: notify wakes the main agent with the result, delivered as steer", async () => {
	const s = agentSetup({ text: "report body" }, true);
	await s.run.done;
	const last = s.pi.messages.at(-1)!;
	assert.deepEqual(last.options, { triggerTurn: true, deliverAs: "steer" });
	assert.match(JSON.stringify(last.message.content), /report body/);
});

test("agent: provider failure, cleanup problems and creation failure are errors", async () => {
	const failed = agentSetup({ failure: "provider error" });
	assert.equal((await failed.run.done).error, "provider error");
	const dirty = agentSetup({ text: "ok", cleanup: "dispose failed: x" });
	const outcome = await dirty.run.done;
	assert.equal(outcome.status, "success", "a result that arrived is still a result");
	assert.match(JSON.stringify(dirty.pi.messages.at(-1)!.message.details), /"phase":"done"/);
	const pi = fakePi();
	const run = runAgentJob({ pi, clock: new ManualClock(), createChild: async () => { throw new Error("model: unknown model \"zz\""); }, active: new Set() }, makeJob({ kind: "agent", prompt: "p", model: "zz" }) as never, info);
	assert.equal(await run.started, false);
	assert.match((await run.done).error!, /unknown model/);
});

test("agent: the 30 minute limit aborts the child and reports a timeout; shutdown cancels without a marker", async () => {
	const timed = agentSetup({ hang: true });
	await timed.clock.settle();
	await timed.clock.advance(AGENT_TIMEOUT_MS);
	assert.equal(timed.fake.state.aborted, true);
	assert.equal((await timed.run.done).error, "timed out after 30 minutes");
	const cancelled = agentSetup({ hang: true });
	await cancelled.clock.settle();
	for (const controller of [...cancelled.active]) controller.abort();
	assert.match((await cancelled.run.done).error!, /cancelled because the session ended/);
	assert.deepEqual(cancelled.pi.phases(), ["start"]);
});

test("executor: dispatches by kind; monitor jobs go through the injected Monitor starter", async () => {
	const pi = fakePi();
	const calls: string[] = [];
	const executor = createExecutor({
		pi: pi as never, context: () => ({ cwd: process.cwd() }) as never, trusted: () => true, clock: new ManualClock(),
		exec: async (tool, command, _signal, events) => { calls.push(`${tool}:${command}`); events.started(); events.closed(0, null, false); },
		createChild: async () => fakeChild({ text: "x" }).child,
		monitorStarter: () => ({ validate: () => undefined, start: () => ({ monitorId: "m1" }), isActive: () => false }),
	});
	assert.equal((await executor.execute(makeJob({ prompt: "p" }), info).done).status, "success");
	assert.equal((await executor.execute(makeJob({ kind: "agent", prompt: "p", model: "m" }), info).done).status, "success");
	assert.equal((await executor.execute(makeJob({ kind: "shell", command: "echo", shell: "bash" }), info).done).status, "success");
	assert.deepEqual(calls, ["bash:echo"]);
	const monitor = executor.execute(makeJob({ kind: "monitor", start: { source: { kind: "system" } } }), info);
	assert.equal(await monitor.started, true);
	assert.equal((await monitor.done).status, "success");
	executor.abortAll();
});

test("TailBuffer keeps the last bytes and drops a partial character at the cut", () => {
	const tail = new TailBuffer(6);
	tail.push(Buffer.from("abc"));
	tail.push(Buffer.from("defghij"));
	assert.equal(tail.text(), "efghij");
	const cjk = new TailBuffer(4);
	cjk.push(Buffer.from("一二三四")); // 12 bytes; the last 4 bytes begin inside a character
	assert.equal(cjk.text(), "四");
});

test("resolveCwd: relative paths resolve inside the project; a link out of it counts as outside", () => {
	const project = dir(), outside = dir();
	try {
		mkdirSync(join(project.root, "sub"));
		const inside = resolveCwd(project.root, "sub");
		assert.ok(inside.ok && !inside.outsideProject);
		const sibling = resolveCwd(project.root, outside.root);
		assert.ok(sibling.ok && sibling.outsideProject);
		try {
			symlinkSync(outside.root, join(project.root, "link"), "junction");
			const linked = resolveCwd(project.root, "link");
			assert.ok(linked.ok && linked.outsideProject, "realpath exposes the link target");
		} catch { /* links may be unavailable on this machine */ }
		assert.equal(resolveCwd(project.root, "missing").ok, false);
	} finally { project.done(); outside.done(); }
});

test("live copies: a running shell job exposes its output, and the copy is released with the run", async () => {
	const { LiveRuns } = await import("../src/live-runs.ts");
	const s = shellSetup();
	const changes: string[] = [];
	const live = new LiveRuns(() => changes.push("change"));
	try {
		const run = runShellJob({ ...s.deps, live }, makeJob({ kind: "shell", id: "J1", command: "echo hi", shell: "bash" }) as never, info);
		await s.clock.settle();
		const copy = live.get("J1")!;
		assert.ok(copy, "a copy exists while the command runs");
		s.control.state.events!.started();
		s.control.state.events!.stdout(Buffer.from("line one\n"));
		s.control.state.events!.stderr(Buffer.from("line two\n"));
		assert.equal((copy as { snapshot(): { text: string } }).snapshot().text, "line one\nline two\n");
		s.control.state.events!.closed(0, null, false);
		s.control.state.finish!();
		await run.done;
		assert.equal(live.get("J1"), undefined, "released at the end of the run");
		assert.equal(copy.isReleased, true);
		assert.equal(changes.length, 2, "appearing and going away both notify the panel");
		assert.equal(s.pi.messages[1].message.details.output, "line one\nline two", "the marker output is unchanged");
	} finally { s.d.done(); }
});

test("live copies: a newer run of the same job is not released by an older run", async () => {
	const { LiveRuns } = await import("../src/live-runs.ts");
	const { OutputTranscript } = await import("../../../shared/src/background/index.ts");
	const live = new LiveRuns();
	const first = new OutputTranscript(), second = new OutputTranscript();
	live.set("J", first);
	live.set("J", second);
	assert.equal(first.isReleased, true, "replacing a copy releases the old one");
	live.release("J", first);
	assert.equal(live.get("J"), second);
	live.releaseAll();
	assert.equal(second.isReleased, true);
	assert.equal(live.get("J"), undefined);
});

test("live copies: a running agent job exposes the child's conversation and releases it on every ending", async () => {
	const { LiveRuns } = await import("../src/live-runs.ts");
	const { LiveTranscript } = await import("../../../shared/src/background/index.ts");
	for (const throws of [undefined, "boom"]) {
		const pi = fakePi(), clock = new ManualClock(), live = new LiveRuns();
		const transcript = new LiveTranscript();
		let seen: unknown;
		const child: ChildSession = {
			transcript,
			async run() { seen = live.get("A1"); if (throws) throw new Error(throws); return { text: "done" }; },
			abort() {},
			async dispose() { return undefined; },
		};
		const run = runAgentJob({ pi, clock, createChild: async () => child, active: new Set(), live }, makeJob({ kind: "agent", id: "A1", prompt: "p", model: "m1" }) as never, info);
		await run.done;
		assert.equal(seen, transcript, "visible while the child runs");
		assert.equal(live.get("A1"), undefined);
		assert.equal(transcript.isReleased, true);
	}
});
