import assert from "node:assert/strict";
import test from "node:test";
import { StartupDiagnostics } from "../extensions/subagent/startup-diagnostics.ts";

const token = "PRIVATE_BRIDGE_TOKEN";
const report = (phase: string, extra: Record<string, unknown> = {}) => ({ channel: "pi-subagent-startup", token, phase, piVersion: "1.0.0", nodeVersion: "v26.1.0", ...extra });

test("startup diagnostics distinguish unobserved guard from reported guard success without guessing a cause", () => {
	let now = 0; const startup = new StartupDiagnostics(token, () => now);
	startup.launch({ command: "/node", args: ["/pi/cli.js", "--SECRET_FLAG", "SECRET_ARGUMENT"] });
	startup.spawnObserved(123);
	startup.enter("awaiting_get_state");
	startup.observeRpc({ event: "queued", id: "request-1", command: "get_state", elapsedMs: 0, deadlineMs: 30000 });
	startup.observeRpc({ event: "write_completed", id: "request-1", command: "get_state", elapsedMs: 1 });
	now = 30001;
	const message = startup.failureMessage("RPC startup failed: RPC_DEADLINE: get_state response not received");
	assert.match(message, /^RPC startup failed: RPC_DEADLINE/);
	assert.match(message, /awaiting_get_state/);
	assert.match(message, /No guard milestone was observed/);
	assert.match(message, /not proof that the child read it/);
	assert.match(message, /Exact cause is unknown/);
	assert.match(message, /Initial task prompt requested: no/);
	assert.doesNotMatch(message, /PRIVATE_BRIDGE_TOKEN|SECRET_FLAG|SECRET_ARGUMENT|extension X is stuck/);
	const frozen = startup.snapshot();
	assert.equal(startup.receive(report("guard_verified")), false, "late observations cannot rewrite failure-time evidence");
	startup.terminationRequested(); startup.processClosed(1, "SIGTERM");
	assert.deepEqual(startup.snapshot(), frozen);
	assert.match(startup.cleanupMessage(), /child close observed: yes/);
	assert.match(startup.cleanupMessage(), /Termination requested: yes/);
	assert.match(startup.cleanupMessage(), /does not confirm.*process tree/);

	const verified = new StartupDiagnostics(token, () => now);
	assert.equal(verified.receive(report("guard_verified")), true);
	verified.enter("awaiting_get_state");
	assert.match(verified.failureMessage("RPC startup failed: RPC_DEADLINE"), /Guard reported successful checks/);
});

test("startup IPC uses token and a bounded allowlist; extra payloads and malformed milestones are ignored", () => {
	const startup = new StartupDiagnostics(token, () => 0);
	for (const value of [null, [], report("guard_loaded", { token: "wrong" }), report("not_a_stage"), report("guard_loaded", { task: "SECRET_TASK" }), report("guard_loaded", { piVersion: "x".repeat(1000) }), report("guard_rejected", { errorCode: "SECRET_ERROR" })]) {
		assert.equal(startup.receive(value), false);
	}
	assert.equal(startup.receive(report("guard_loaded")), true);
	assert.equal(startup.receive(report("guard_loaded")), false, "reload/duplicates must not grow retained metadata");
	assert.equal(startup.receive(report("guard_session_start")), true);
	assert.equal(startup.receive(report("guard_rejected", { errorCode: "TRUST_REQUIRED" })), true);
	assert.match(startup.failureMessage("RPC startup failed: child exited"), /Guard reported rejection: TRUST_REQUIRED/);
	assert.doesNotMatch(JSON.stringify(startup.snapshot()), /PRIVATE_BRIDGE_TOKEN|SECRET/);
});

test("startup diagnostics keep counts and bounded timeline, not stdout or extension UI text", () => {
	let now = 0; const startup = new StartupDiagnostics(token, () => now);
	startup.enter("submitting_initial_prompt");
	for (let i = 0; i < 200; i++) {
		now++;
		startup.observeBytes("stdout", 1024);
		startup.observeBytes("stderr", 10);
		startup.observeUiRequest();
		startup.observeRpc({ event: "unmatched_response", elapsedMs: 0 });
	}
	const snapshot = startup.snapshot();
	assert.equal(snapshot.stdoutBytes, 200 * 1024);
	assert.equal(snapshot.stderrBytes, 2000);
	assert.equal(snapshot.uiRequests, 200);
	assert.equal(snapshot.unmatchedResponses, 200);
	assert.ok(snapshot.timeline.length <= 24);
	assert.ok(snapshot.timelineOmitted > 0);
	assert.ok(JSON.stringify(snapshot).length < 8192);
	assert.match(startup.failureMessage("RPC startup failed: no prompt reply"), /Initial task prompt requested: yes/);
	assert.match(startup.failureMessage("ignored later failure"), /^RPC startup failed: no prompt reply/);
});

test("startup completion stops diagnostic collection and does not turn milestones into readiness proof", () => {
	const startup = new StartupDiagnostics(token, () => 0);
	startup.receive(report("guard_verified"));
	assert.equal(startup.snapshot().phase, "spawning_child");
	startup.enter("verifying_startup_guard"); startup.checkpoint("startup_guard_verified");
	startup.ready();
	assert.equal(startup.isStarting, false);
	assert.equal(startup.hasFailure, false);
	const snapshot = startup.snapshot();
	startup.observeRpc({ event: "queued", id: "ignored", command: "steer", elapsedMs: 0, deadlineMs: 30000 });
	startup.observeBytes("stdout", 10);
	assert.equal(startup.receive(report("guard_rejected", { errorCode: "TRUST_REQUIRED" })), false);
	assert.deepEqual(startup.snapshot(), snapshot);
});
