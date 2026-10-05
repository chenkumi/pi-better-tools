import assert from "node:assert/strict";
import { ulid } from "ulid";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildSubagentPiArgs } from "../extensions/subagent/child-args.ts";

const persistence = { kind: "new" as const, sessionDir: "/managed/pi", sessionId: ulid().toLowerCase() };

function optionValue(args: string[], option: string): string | undefined {
	const index = args.indexOf(option);
	return index === -1 ? undefined : args[index + 1];
}

function expectSubagentExcluded(args: string[]) {
	assert.equal(args.filter((arg) => arg === "--exclude-tools").length, 1);
	assert.deepEqual(optionValue(args, "--exclude-tools")?.split(","), ["subagent", "subagent_status", "subagent_cancel", "subagent_message"]);
}

test("bundled scout inherits the parent model", () => {
	const scout = readFileSync(new URL("../agents/scout.md", import.meta.url), "utf8");

	assert.equal(/^model:/m.test(scout), false);
});

test("worker-style child with no tools excludes recursive dispatch", () => {
	const args = buildSubagentPiArgs({ persistence, taskPath: "/tmp/task.txt" });

	expectSubagentExcluded(args);
	assert.equal(args.includes("--tools"), false);
});

test("allowlisted bundled agents retain their tools and exclude subagent", () => {
	const args = buildSubagentPiArgs({ persistence,
		taskPath: "/tmp/task.txt",
		tools: ["read", "grep", "find", "ls", "bash"],
	});

	expectSubagentExcluded(args);
	assert.equal(optionValue(args, "--tools"), "read,grep,find,ls,bash");
});

test("a user agent cannot re-enable subagent through its tools list", () => {
	const args = buildSubagentPiArgs({ persistence, taskPath: "/tmp/task.txt", tools: ["read", "subagent"] });

	expectSubagentExcluded(args);
	assert.equal(optionValue(args, "--tools"), "read,subagent");
});

test("provider-resolved model, thinking level, and prompt path are preserved", () => {
	const args = buildSubagentPiArgs({ persistence,
		taskPath: "/tmp/task.txt",
		model: "openai-codex/gpt-5.4",
		thinkingLevel: "high",
		promptPath: "/tmp/prompt-worker.md",
	});

	expectSubagentExcluded(args);
	assert.equal(optionValue(args, "--model"), "openai-codex/gpt-5.4");
	assert.equal(optionValue(args, "--thinking"), "high");
	assert.equal(optionValue(args, "--append-system-prompt"), "/tmp/prompt-worker.md");
});

for (const kind of ["new", "resume"] as const) test(`RPC ${kind} preserves managed identity/guard and excludes print/task argv`, () => {
	const saved = kind === "new" ? persistence : { kind, sessionDir: "/managed/pi", sessionFile: "/managed/pi/native.jsonl" };
	const args = buildSubagentPiArgs({ persistence: saved, transport: "rpc", guardPath: "/module/child-guard.ts", bridgePath: "/module/child-bridge.ts", taskPath: "/tmp/task.txt", model: "offline/fixture", thinkingLevel: "off", promptPath: "/tmp/system.md" });
	expectSubagentExcluded(args); assert.equal(optionValue(args, "--mode"), "rpc"); assert.equal(args.includes("-p"), false);
	assert.equal(args.some(arg => arg.startsWith("@")), false); assert.equal(optionValue(args, "--session-dir"), "/managed/pi");
	assert.equal(optionValue(args, kind === "new" ? "--session-id" : "--session"), kind === "new" ? persistence.sessionId : "/managed/pi/native.jsonl");
	assert.deepEqual(args.flatMap((arg, index) => arg === "-e" ? [args[index + 1]] : []), ["/module/child-guard.ts", "/module/child-bridge.ts"]);
	assert.equal(optionValue(args, "--model"), "offline/fixture"); assert.equal(optionValue(args, "--thinking"), "off"); assert.equal(optionValue(args, "--append-system-prompt"), "/tmp/system.md");
	assert.equal(args.includes("--approve"), false); assert.equal(args.includes("--no-session"), false);
});

test("installed Pi @file pipeline preserves long task content without recursive file expansion", async () => {
	// Compatibility check against the installed peer, with no model/network request.
	const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
	const { parseArgs } = await import(new URL("./cli/args.js", piEntry).href);
	const { processFileArguments } = await import(new URL("./cli/file-processor.js", piEntry).href);
	const { buildInitialMessage } = await import(new URL("./cli/initial-message.js", piEntry).href);
	const dir = await mkdtemp(join(tmpdir(), "pi-task-transport-"));
	try {
		const taskPath = join(dir, "task.txt");
		const content = `Task:   @nonexistent.txt\n--model fake\n${"中文🙂 $& $$ ".repeat(5000)}\n\t  `;
		await writeFile(taskPath, content, { encoding: "utf8", mode: 0o600 });
		const args = buildSubagentPiArgs({ persistence, taskPath });
		assert.ok(args.join(" ").length < 4000);
		const parsed = parseArgs(args);
		assert.deepEqual(parsed.fileArgs, [taskPath]);
		assert.deepEqual(parsed.messages, []);
		const { text, images } = await processFileArguments(parsed.fileArgs);
		const { initialMessage } = buildInitialMessage({ parsed, fileText: text, fileImages: images });
		assert.equal(initialMessage, `<file name="${taskPath}">\n${content}\n</file>\n`);
		assert.deepEqual(images, []);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
