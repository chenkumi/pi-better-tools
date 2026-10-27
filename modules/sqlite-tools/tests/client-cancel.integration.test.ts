import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteClient } from "../src/sqlite-client.js";

const LONG_QUERY = "WITH RECURSIVE counter(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM counter WHERE x<2000000000) SELECT sum(x) AS total FROM counter";
const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function withClient(run: (client: SqliteClient, directory: string) => Promise<void>) {
	const directory = await mkdtemp(join(tmpdir(), "sqlite-client-cancel-"));
	const client = new SqliteClient();
	try { await run(client, directory); }
	finally { await client.dispose(); await rm(directory, { recursive: true, force: true }); }
}

test("a call cancelled while queued does not let a later call overtake the still-running earlier one", async () => {
	await withClient(async (client, directory) => {
		await client.open(join(directory, "a.sqlite"));
		let running = true;
		const first = client.query(LONG_QUERY).then(() => undefined, () => undefined).finally(() => { running = false; });
		await settle(300);
		const controller = new AbortController();
		const cancelled = client.open(join(directory, "b.sqlite"), controller.signal);
		controller.abort();
		await assert.rejects(cancelled, /cancelled/);
		let laterEnded = false;
		const later = client.open(join(directory, "c.sqlite")).then(() => { laterEnded = true; }, () => undefined);
		await settle(300);
		assert.equal(running, true, "the uncancelled long query must still be running");
		assert.equal(laterEnded, false, "the later call must wait for the long query");
		await client.dispose();
		await first;
		await later;
	});
});

test("an open cancelled after it started reports cancellation instead of success", async () => {
	await withClient(async (client, directory) => {
		const controller = new AbortController();
		const opened = client.open(join(directory, "x.sqlite"), controller.signal).catch((error: Error) => error);
		await settle(0);
		controller.abort();
		const result = await opened;
		assert.ok(result instanceof Error && /cancelled/.test(result.message), `expected cancellation, got ${JSON.stringify(result)}`);
		assert.equal(await client.status().then(status => status.isOpen), false, "a cancelled open leaves no open database");
	});
});
