import assert from "node:assert/strict";
import { invokeCli, isolatedEnv } from "./fixtures/pi-cli-harness.ts";
import { callAlias } from "../extensions/subagent/subsession-log.ts";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Opt-in: use a specific installed CLI, never download or upgrade a host silently.
const cli = process.env.PI_SUBAGENTS_TEST_CLI;
const project = fileURLToPath(new URL("../", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/pi-provider.ts", import.meta.url));
const evidence = process.env.PI_SUBAGENTS_TEST_EVIDENCE;
const shellTool = process.platform === "win32" ? "powershell" : "bash";

async function invoke(root: string, scenario: string, mode: string) {
	return invokeCli(resolve(cli!), ["--mode", "json", "-p", "--no-session", "--offline",
		"--no-extensions", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes",
		"-e", project, "-e", fixture, "--model", "subagent-test/fixture", "--tools", "subagent", "Offline contract test"], root,
		{ ...isolatedEnv(root), PI_SUBAGENTS_TEST_SCENARIO: scenario, PI_SUBAGENTS_TEST_MODE: mode }, undefined, 12 * 1024 * 1024);
}

const cases = [
	["normal", "single"], ["retry", "single"], ["retry-exhausted", "single"], ["follow-up", "single"],
	["usage", "single"], ["nested-usage", "single"], ["large-shell", "single"], ["exclusion", "single"],
	["retry", "parallel"], ["retry", "chain"], ["usage", "parallel"], ["usage", "chain"],
	["retry-exhausted", "single", false],
] as const;
for (const [scenario, mode, debugLog = true] of cases) {
	const caseName = `${scenario}-${mode}${debugLog ? "" : "-debug-off"}`;
	test(`real Pi CLI production dispatch: ${scenario}/${mode}${debugLog ? "" : " (debug off)"}`, { skip: !cli && "Set PI_SUBAGENTS_TEST_CLI to a verified installed CLI", timeout: 60000 }, async () => {
		console.log(`[progress] Verifying real CLI contract: ${scenario}/${mode}`);
		const root = await realpath(await mkdtemp(join(tmpdir(), "pi-cli-contract-")));
		try {
			await mkdir(join(root, "config"));
			await writeFile(join(root, "config/settings.json"), JSON.stringify({ extensions: [fixture], packages: [project],
				retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 }, compaction: { enabled: false }, cacheWarming: "off",
				defaultProjectTrust: "never", defaultTools: [shellTool, "metered", "metered_nested", "probe"],
				"pi-subagents": { debugLog }, piSubagents: { debugLog: true } }));
			const actual = await invoke(root, scenario, mode);
			if (evidence) {
				await mkdir(evidence, { recursive: true });
				await writeFile(join(evidence, `${caseName}-events.jsonl`), actual.stdout);
				await writeFile(join(evidence, `${caseName}-stderr.txt`), actual.stderr);
			}
			assert.equal(actual.code, 0, actual.stderr);
			const events = actual.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
			assert.ok(events.some((event) => event.type === "agent_settled"));
			const tool = events.filter((event) => event.type === "message_end" && event.message?.role === "toolResult" && event.message.toolName === "subagent").at(-1)?.message;
			assert.ok(tool, "Parent must invoke the registered subagent tool via the real agent loop");
			const results = tool.details.results;
			// Save transcripts before behavioral assertions, including failed cases.
			if (evidence) for (const [index, result] of results.entries()) {
				if (result.logPath?.startsWith(root)) await writeFile(join(evidence, `${caseName}-${index}-subsession.jsonl`), await readFile(result.logPath));
			}
			assert.equal(results.length, mode === "single" ? 1 : 2);
			const isFailure = scenario === "retry-exhausted";
			assert.equal(Boolean(tool.isError), isFailure);
			// Home and settings are both isolated: verify the production default log path,
			// not a runtime debugLog/debugLogDir override or the user's real home.
			const debugDir = join(root, ".pi", "logs", "pi-subagents");
			if (isFailure && debugLog) {
				const files = await readdir(debugDir);
				assert.equal(files.length, results.length);
				const records = await Promise.all(files.map(async (file) => JSON.parse(await readFile(join(debugDir, file), "utf8"))));
				assert.deepEqual(records.map((record) => record.taskId).sort(), results.map((result: any) => result.taskId).sort());
				for (const [index, record] of records.entries()) {
					assert.equal(record.status, "failed");
					assert.equal(record.stopReason, "error");
					assert.ok(record.errorMessage);
					assert.ok(record.input.task);
					assert.ok(record.debugLogPath.startsWith(debugDir));
					assert.ok(results.some((result: any) => result.logPath === record.subsessionLogPath));
					if (evidence) await writeFile(join(evidence, `${caseName}-${index}-debug.json`), JSON.stringify(record, null, 2));
				}
			} else {
				await assert.rejects(stat(debugDir), { code: "ENOENT" });
			}
			const perCost = ["usage", "nested-usage"].includes(scenario) ? 5 : ["retry", "retry-exhausted", "follow-up"].includes(scenario) ? 2 : scenario === "normal" ? 1 : 2;
			const perTokens = scenario === "nested-usage" ? 48 : scenario === "usage" ? 36 : perCost === 1 ? 12 : 24;
			assert.equal(tool.usage.cost.total, perCost * results.length);
			assert.equal(tool.usage.totalTokens, perTokens * results.length);
			for (const result of results) {
				assert.equal(result.status, isFailure ? "failed" : "completed", result.errorMessage);
				assert.equal(result.stopReason, isFailure ? "error" : "stop");
				assert.equal(result.usage.cost, perCost);
				assert.equal(result.usage.totalTokens, perTokens);
				assert.equal(result.usage.contextTokens, 12);
				if (!isFailure) assert.equal(result.errorMessage, undefined);
				if (scenario === "retry") assert.equal(result.output, "recovered-success");
				else if (scenario === "follow-up") assert.equal(result.output, "first answer\n\nfollow-up answer");
				else if (scenario !== "exclusion" && !isFailure) assert.equal(result.output, "done");
				if (scenario === "exclusion") {
					const probe = JSON.parse(result.output);
					for (const key of ["active", "registered", "callable"]) assert.equal(probe[key].includes("subagent"), false);
				}
				const directory = join(root, "config", "subagent-sessions", result.subagentSessionId);
				// Failed runs retain their per-run evidence without publishing a ready transcript.
				const expectedLog = isFailure ? join(directory, "runs", result.taskId, "transcript.jsonl") : join(directory, "transcript.jsonl");
				assert.equal(result.logPath, await realpath(expectedLog));
				const logText = await readFile(result.logPath, "utf8");
				const log = logText.trim().split("\n").map((line) => JSON.parse(line));
				assert.ok(log.every(entry => ["user", "assistant", "tool_call", "tool_result"].includes(entry.type)));
				assert.match(result.subagentSessionId, /^[0-9a-z]{26}$/);
				assert.equal(result.canResume, !isFailure);
				const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
				assert.equal(manifest.state, isFailure ? "blocked" : "ready");
				assert.ok((await readdir(join(directory, "pi"))).some(file => file.endsWith(".jsonl")));
				await assert.rejects(stat(join(directory, "writer.lock")), { code: "ENOENT" });
				await assert.rejects(stat(join(root, "config", "sub-sessions")), { code: "ENOENT" });
				const metadata = JSON.parse(await readFile(join(directory, "runs", result.taskId, "run.json"), "utf8")).result;
				assert.equal(metadata.status, result.status);
				assert.deepEqual(metadata.usage, result.usage);
				if (["usage", "nested-usage"].includes(scenario)) {
					const canonical = log.filter((entry) => entry.type === "tool_result" && entry.callId === callAlias(result.taskId, "fixture-call"));
					assert.equal(canonical.length, 1);
					assert.equal(canonical[0].usage, undefined); // accounting belongs to metadata, not dialogue
				}
				if (scenario === "large-shell") {
					const call = log.find(entry => entry.type === "tool_call" && entry.name === shellTool);
					assert.ok(call, "must execute the platform's real shell tool");
					const shell = log.find(entry => entry.type === "tool_result" && entry.callId === call?.callId);
					assert.ok(shell);
					assert.equal(shell.isError, false);
					assert.ok(logText.length < 10000, "structured shell payload must not inflate the child transcript");
					const native = (await readFile(join(directory, manifest.nativeFile), "utf8")).trim().split("\n").map(line => JSON.parse(line));
					const nativeShell = native.map(entry => entry.message).find(message => message?.role === "toolResult" && message.toolName === shellTool);
					assert.ok(nativeShell, "native session must retain the actual shell result");
					assert.equal(nativeShell.isError, false);
					assert.equal(nativeShell.details.truncation.truncated, true);
					const outputPath = nativeShell.details.fullOutputPath;
					try {
						const fullOutput = await readFile(outputPath, "utf8");
						assert.equal(fullOutput.slice(0, 614400), "x".repeat(614400));
						assert.ok(Buffer.byteLength(fullOutput) > 614400, "fixture must actually produce >600 KiB");
						assert.equal(fullOutput.slice(614400).replace(/\r\n/g, "\n"), "\n" + ".\n".repeat(2000));
						assert.ok(!logText.includes("x".repeat(10000)), "full structured payload must not leak into transcript");
					} finally { await rm(outputPath, { force: true }); }
				}
			}
		} finally { await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
		console.log(`[progress] Verified and cleaned: ${scenario}/${mode}`);
	});
}
