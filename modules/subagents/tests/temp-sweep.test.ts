import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promptDirectoryPrefix, queryDirectoryPrefix, sweepStaleTempDirectories } from "../extensions/subagent/temp-sweep.ts";

const exists = (path: string) => stat(path).then(() => true, () => false);

test("sweepStaleTempDirectories removes only old pi-subagent directories", async () => {
	const root = await mkdtemp(join(tmpdir(), "temp-sweep-"));
	try {
		const old = new Date(Date.now() - 25 * 3600_000);
		const staleDir = join(root, "pi-subagent-Ab3xYz"), staleQuery = join(root, "pi-subagent-query-Ab3xYz");
		const freshDir = join(root, "pi-subagent-Fr3shA"), other = join(root, "unrelated-old"), plainFile = join(root, "pi-subagent-F1l3Ab");
		for (const dir of [staleDir, staleQuery, freshDir, other]) { await mkdir(dir); await writeFile(join(dir, "task.txt"), "x"); }
		await writeFile(plainFile, "x");
		for (const path of [staleDir, staleQuery, other, plainFile]) await utimes(path, old, old);
		await sweepStaleTempDirectories(root);
		assert.equal(await exists(staleDir), false);
		assert.equal(await exists(staleQuery), false);
		assert.equal(await exists(freshDir), true, "a recent directory may belong to a live run");
		assert.equal(await exists(other), true, "only the module's own prefix is swept");
		assert.equal(await exists(plainFile), true, "only directories are removed");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("sweepStaleTempDirectories keeps an old directory whose owner process is alive", async () => {
	const root = await mkdtemp(join(tmpdir(), "temp-sweep-"));
	try {
		const old = new Date(Date.now() - 25 * 3600_000);
		const live = join(root, `pi-subagent-${process.pid}-abcdef`), dead = join(root, "pi-subagent-2147483646-abcdef");
		for (const dir of [live, dead]) await mkdir(dir);
		for (const dir of [live, dead]) await utimes(dir, old, old);
		await sweepStaleTempDirectories(root);
		assert.equal(await exists(live), true);
		assert.equal(await exists(dead), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("sweepStaleTempDirectories never follows a link or fails on a missing root", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "temp-sweep-"));
	const target = await mkdtemp(join(tmpdir(), "temp-sweep-target-"));
	try {
		await writeFile(join(target, "keep.txt"), "x");
		try { await symlink(target, join(root, "pi-subagent-L1nkAb"), "junction"); } catch { t.skip("links unavailable"); return; }
		const old = new Date(Date.now() - 25 * 3600_000);
		await utimes(join(root, "pi-subagent-L1nkAb"), old, old).catch(() => undefined);
		await sweepStaleTempDirectories(root);
		assert.equal(await exists(join(target, "keep.txt")), true);
		await assert.doesNotReject(sweepStaleTempDirectories(join(root, "missing")));
	} finally {
		await rm(root, { recursive: true, force: true }); await rm(target, { recursive: true, force: true });
	}
});

test("sweepStaleTempDirectories keeps a live query copy, ignores foreign names and matches the generated prefixes", async () => {
	const root = await mkdtemp(join(tmpdir(), "temp-sweep-"));
	try {
		const old = new Date(Date.now() - 25 * 3600_000);
		const liveQuery = await mkdtemp(join(root, queryDirectoryPrefix())), livePrompt = await mkdtemp(join(root, promptDirectoryPrefix()));
		const foreign = join(root, "pi-subagent-notes-for-me"), deadQuery = join(root, "pi-subagent-query-2147483646-abcdef");
		await mkdir(foreign); await mkdir(deadQuery);
		for (const dir of [liveQuery, livePrompt, foreign, deadQuery]) await utimes(dir, old, old);
		await sweepStaleTempDirectories(root);
		assert.equal(await exists(liveQuery), true);
		assert.equal(await exists(livePrompt), true);
		assert.equal(await exists(foreign), true, "a name this module does not generate is left alone");
		assert.equal(await exists(deadQuery), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
