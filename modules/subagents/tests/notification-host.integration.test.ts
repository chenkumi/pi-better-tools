import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isolatedEnv } from "./fixtures/pi-cli-harness.ts";

// True SDK/host boundary cases belong to integration, not mocked unit tests.
test("real Pi 1.1.0 SDK observes streaming queue, idle persistence and async host failure without delivery ack", { timeout: 60000 }, async t => {
	const root = await mkdtemp(join(tmpdir(), "pi-notification-sdk-"));
	const fixture = fileURLToPath(new URL("./fixtures/notification-host.ts", import.meta.url));
	const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), fixture], { cwd: root, env: isolatedEnv(root), stdio: ["ignore", "pipe", "pipe"] });
	let output = "", diagnostic = "";
	child.stdout.on("data", value => { output += value.toString(); process.stdout.write(value); });
	child.stderr.on("data", value => { diagnostic += value.toString(); });
	const closed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
	const abort = () => { child.kill(); }; t.signal.addEventListener("abort", abort, { once: true });
	try {
		assert.equal(await closed, 0, diagnostic);
		const result = JSON.parse(output.trim().split("\n").at(-1)!);
		assert.equal(result.hostVersion, "1.1.0"); assert.equal(result.status, "passed");
		assert.deepEqual(result.cases.map((entry: any) => entry.mode), ["streaming", "idle", "async-failure"]);
		assert.equal(result.cases[0].queuedObserved, 1); assert.equal(result.cases[0].persistedObserved, true);
		assert.equal(result.cases[1].persistedObserved, true); assert.equal(result.cases[2].hostAsyncFailureObserved, true);
		assert.ok(result.cases.every((entry: any) => entry.extensionHostAcknowledgment === "unknown" && entry.callbackAttempts === 1));
	} finally {
		t.signal.removeEventListener("abort", abort);
		if (child.exitCode === null && child.signalCode === null) { child.kill(); await closed; }
		await rm(root, { recursive: true, force: true });
	}
});
