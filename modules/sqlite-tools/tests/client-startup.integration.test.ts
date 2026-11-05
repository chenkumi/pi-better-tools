import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SqliteClient } from "../src/sqlite-client.js";

const HANG = `--require=${fileURLToPath(new URL("./fixtures/swallow-ready.cjs", import.meta.url)).split(String.fromCharCode(92)).join("/")}`;
const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Runs `run` while every helper the client starts hangs before it reports ready. */
async function withHangingHelper(startupTimeoutMs: number | undefined, run: (client: SqliteClient, directory: string) => Promise<void>) {
	const directory = await mkdtemp(join(tmpdir(), "sqlite-client-startup-"));
	const client = new SqliteClient(startupTimeoutMs);
	const before = process.env.NODE_OPTIONS;
	process.env.NODE_OPTIONS = HANG;
	try { await run(client, directory); }
	finally {
		if (before === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = before;
		await client.dispose(); await rm(directory, { recursive: true, force: true });
	}
}

test("a call cancelled while the helper is still starting settles, kills the helper and frees the queue", async () => {
	await withHangingHelper(undefined, async (client, directory) => {
		const controller = new AbortController();
		const opening = client.open(join(directory, "a.sqlite"), controller.signal);
		const outcome = opening.then(() => "resolved", (error: Error) => error.message);
		await settle(500);
		controller.abort();
		assert.match(await Promise.race([outcome, settle(5000).then(() => "still pending")]), /cancelled/);
		// The queue moved on: a later call is not stuck behind the dead start.
		const later = client.status();
		assert.deepEqual(await Promise.race([later, settle(5000).then(() => "still pending")]), { isOpen: false, filePath: null, tables: null });
	});
});

test("a helper that never reports ready is terminated after the startup bound", async () => {
	await withHangingHelper(1000, async (client, directory) => {
		const started = Date.now();
		const outcome = await client.open(join(directory, "a.sqlite")).then(() => "resolved", (error: Error) => error.message);
		assert.match(outcome, /did not report ready within 1 seconds; the SQLite process was terminated/);
		assert.ok(Date.now() - started < 8000, "the call must not wait for the helper forever");
	});
});

test("without the hang the same client starts normally (the fixture is the only cause)", async () => {
	const directory = await mkdtemp(join(tmpdir(), "sqlite-client-startup-"));
	const client = new SqliteClient(1000);
	try { assert.equal((await client.open(join(directory, "a.sqlite"))).success, true); }
	finally { await client.dispose(); await rm(directory, { recursive: true, force: true }); }
});
