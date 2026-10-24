import assert from "node:assert/strict";
import test from "node:test";

// SA-002: the 32-submitted / 8-active limits are process-wide. Pi re-evaluates the extension modules on /reload, so
// module-level counters would start again from zero while the previous instance's children are still running.
const adopted = (path: string, tag: string) => import(`${path}?reload=${tag}`);

test("the submitted-task budget survives a module re-evaluation (/reload)", async () => {
	const first = await adopted("../extensions/subagent/background.ts", "first");
	const second = await adopted("../extensions/subagent/background.ts", "second");
	assert.notEqual(first.BackgroundJobs, second.BackgroundJobs, "two independent module instances, as after /reload");
	let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
	const oldJobs = new first.BackgroundJobs(() => {});
	const newJobs = new second.BackgroundJobs(() => {});
	try {
		oldJobs.submit("owner", "/cwd", oldJobs.epoch, ["a", "b", "c"], async () => { await hold; });
		assert.match(oldJobs.load(), /submitted 3\/32/);
		assert.match(newJobs.load(), /submitted 3\/32/, "the new instance sees the old instance's admissions");
		assert.throws(() => newJobs.submit("owner", "/cwd", newJobs.epoch, Array.from({ length: 30 }, (_, i) => `t${i}`), async () => { await hold; }), /BACKGROUND_CAPACITY/);
	} finally {
		release(); await oldJobs.shutdown(); await newJobs.shutdown();
	}
	assert.match(new second.BackgroundJobs(() => {}).load(), /submitted 0\/32/, "budget is returned once the work settled");
});

test("the active-child semaphore is one per process, not one per module instance", async () => {
	const key = Symbol.for("pi-better-tools.subagents.active-children.v1");
	const registry = globalThis as unknown as Record<symbol, { free: number; acquire(): Promise<(() => void) | undefined> } | undefined>;
	delete registry[key];
	await adopted("../extensions/subagent/index.ts", "first");
	const semaphore = registry[key];
	assert.ok(semaphore, "index.ts publishes its semaphore process-wide");
	const free = semaphore.free;
	await adopted("../extensions/subagent/index.ts", "second");
	assert.equal(registry[key], semaphore, "a second module instance adopts the existing semaphore");
	const release = await semaphore.acquire();
	assert.equal(registry[key]!.free, free - 1);
	release?.();
});
