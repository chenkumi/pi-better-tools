import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_TIMEOUT_MS, runAgentJob, type ChildSession } from "../src/agent-run.ts";
import { createExecutor } from "../src/executor.ts";
import { shellProblem } from "../src/guard.ts";
import { MARKER_TYPE, type MarkerDetails } from "../src/markers.ts";
import { runPromptJob } from "../src/prompt-run.ts";
import { runShellJob } from "../src/shell-run.ts";
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

const ctx = () => ({ cwd: process.cwd(), sessionManager: { getSessionId: () => "s1" } }) as never;

/** A Shell Tools double: records what it was asked to start. */
function fakeStarter(result: { jobId: string } | { error: string } = { jobId: "SJ1" }) {
	const calls: Array<{ tool: string; command: string; timeoutMs?: number }> = [];
	return { calls, starter: () => ({ start: (params: { tool: string; command: string; timeoutMs?: number }) => { calls.push(params); return result; } }) };
}

function shellSetup(over: { active?: string[]; starter?: ReturnType<typeof fakeStarter> | "none" } = {}) {
	const pi = fakePi(over.active);
	const fake = over.starter === "none" ? undefined : over.starter ?? fakeStarter();
	const deps = { pi, context: ctx, activeTools: () => pi.getActiveTools(), ...(over.starter === "none" ? { starter: () => undefined } : { starter: fake!.starter }) };
	return { pi, fake, deps };
}

test("shell: success adds one Shell job and ends the run; the agent is told, without being woken", async () => {
	const s = shellSetup();
	const run = runShellJob(s.deps, makeJob({ kind: "shell", id: "J1", name: "nightly", command: "echo hi", shell: "bash", timeoutMs: 5000 }) as never, info);
	assert.equal(await run.started, true);
	assert.equal((await run.done).status, "success");
	assert.deepEqual(s.fake!.calls, [{ tool: "bash", command: "echo hi", timeoutMs: 5000 }]);
	assert.deepEqual(s.pi.phases(), ["done"]);
	const sent = s.pi.messages[0];
	assert.equal(sent.message.customType, MARKER_TYPE);
	assert.deepEqual(sent.options, { triggerTurn: false }, "informs but never wakes");
	const text = (sent.message.content[0] as { text: string }).text;
	assert.match(text, /^Scheduled job "nightly" \(J1\) started shell job SJ1 at 2030-01-01T00:00:00.000Z\. Its completion will be reported separately\.$/);
	assert.doesNotMatch(text, /echo hi/, "the command text is not sent to the model");
});

test("shell: a refused start is an error that the agent is told about", async () => {
	const s = shellSetup({ starter: fakeStarter({ error: "capacity limit reached" }) });
	const run = runShellJob(s.deps, makeJob({ kind: "shell", id: "J2", name: "n", command: "x", shell: "bash" }) as never, info);
	assert.equal(await run.started, false);
	const outcome = await run.done;
	assert.equal(outcome.status, "error");
	assert.match(outcome.error ?? "", /capacity limit reached/);
	assert.equal(s.pi.messages.length, 1);
	assert.match((s.pi.messages[0].message.content[0] as { text: string }).text, /could not start its shell job: capacity limit reached/);
	assert.deepEqual(s.pi.messages[0].options, { triggerTurn: false });
});

test("shell: the shell tool must be enabled, and there is no fallback to the other shell", async () => {
	const s = shellSetup({ active: ["powershell"] });
	const run = runShellJob(s.deps, makeJob({ kind: "shell", command: "x", shell: "bash" }) as never, info);
	assert.equal((await run.done).status, "error");
	assert.equal(s.fake!.calls.length, 0);
	assert.match(shellProblem(["powershell"], "bash") ?? "", /bash tool/);
	assert.equal(shellProblem(["bash"], "bash"), undefined);
});

test("shell: without Shell Tools in this session nothing starts", async () => {
	const s = shellSetup({ starter: "none" });
	const run = runShellJob(s.deps, makeJob({ kind: "shell", command: "x", shell: "bash" }) as never, info);
	const outcome = await run.done;
	assert.equal(outcome.status, "error");
	assert.match(outcome.error ?? "", /Shell Tools is not available/);
});

test("shell: a stored cwd is refused instead of running somewhere else", async () => {
	const s = shellSetup();
	const run = runShellJob(s.deps, makeJob({ kind: "shell", command: "x", shell: "bash", cwd: "/tmp" }) as never, info);
	const outcome = await run.done;
	assert.equal(outcome.status, "error");
	assert.match(outcome.error ?? "", /no longer supports a working directory/);
	assert.equal(s.fake!.calls.length, 0);
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
		pi: pi as never, context: ctx, trusted: () => true, clock: new ManualClock(),
		shellStarter: () => ({ start: (params) => { calls.push(`${params.tool}:${params.command}`); return { jobId: "SJ" }; } }),
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
