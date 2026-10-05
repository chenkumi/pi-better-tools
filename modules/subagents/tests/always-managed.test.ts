import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import registerSubagent from "../extensions/subagent/index.ts";
import { buildSubagentPiArgs } from "../extensions/subagent/child-args.ts";

const child = fileURLToPath(new URL("./fixtures/managed-native.mjs", import.meta.url));
async function setup(scenario = "normal") {
	const root = await mkdtemp(join(tmpdir(), "pi-always-managed-"));
	let tool!: ToolDefinition;
	const invocations: string[][] = [];
	registerSubagent({ registerTool(t) { tool = t; }, on() {} } as ExtensionAPI, {
		debugLog: false, sessionRootDir: join(root, "managed"),
		invocation(args) { invocations.push([...args]); return { command: process.execPath, args: [child, scenario, ...args] }; },
	});
	const models = [{ provider: "offline-fixture", id: "model", reasoning: true }, { provider: "offline-fixture", id: "alternate", reasoning: false }];
	const ctx = { cwd: root, hasUI: false, isProjectTrusted: () => false, model: models[0], thinkingLevel: "off",
		sessionManager: { getSessionId: () => "parent" }, modelRegistry: {
			find: (provider: string, id: string) => models.find(model => model.provider === provider && model.id === id), getAll: () => models,
		} } as unknown as ExtensionContext;
	return { root, tool, ctx, invocations,
		execute: (id: string, args: any) => tool.execute(id, args, undefined, undefined, ctx),
		manifest: async (id: string) => JSON.parse(await readFile(join(root, "managed", id, "manifest.json"), "utf8")),
		dispose: () => rm(root, { recursive: true, force: true }),
	};
}
for (const mode of ["single", "parallel", "chain"] as const) {
	test(`default ${mode} creates separate verified managed native sessions without an opt-in`, async () => {
		const h = await setup();
		try {
			assert.equal(h.tool.parameters.properties.resumable, undefined);
			const task = { agent: "worker", task: "isolated work" };
			const outcome = await h.execute(mode, mode === "single" ? task : mode === "parallel" ? { tasks: [task, task] } : { chain: [task, { ...task, task: "follow-on {previous}" }] });
			assert.equal(outcome.isError, undefined, JSON.stringify(outcome.content));
			const results = outcome.details.results;
			assert.equal(results.length, mode === "single" ? 1 : 2);
			assert.equal(new Set(results.map((r: any) => r.subagentSessionId)).size, results.length);
			for (const result of results) {
				assert.equal(result.status, "completed"); assert.equal(result.canResume, true);
				const manifest = await h.manifest(result.subagentSessionId);
				assert.equal(manifest.state, "ready"); assert.ok(manifest.checkpoint.nativeSha256);
				// Storage returns canonical paths, including macOS /var → /private/var.
				assert.equal(result.logPath, await realpath(join(h.root, "managed", result.subagentSessionId, "transcript.jsonl")));
				assert.equal(JSON.parse(result.output).previousUsers, 0);
				await stat(join(h.root, "managed", result.subagentSessionId, manifest.nativeFile));
				await assert.rejects(stat(join(h.root, "managed", result.subagentSessionId, "writer.lock")), { code: "ENOENT" });
			}
			for (const args of h.invocations) {
				assert.equal(args.includes("--no-session"), false); assert.ok(args.includes("--session-dir")); assert.ok(args.includes("--session-id"));
				assert.ok(args[args.indexOf("-e") + 1].endsWith("child-guard.ts"));
				assert.equal(args[args.indexOf("--exclude-tools") + 1], "subagent,subagent_status,subagent_cancel,subagent_message");
			}
			assert.deepEqual((await readdir(h.root)).sort(), ["managed"]);
		} finally { await h.dispose(); }
	});
}
test("default managed task resumes native history under the same identity and preserves the prior transcript prefix", async () => {
	const h = await setup();
	try {
		const first = (await h.execute("first", { agent: "worker", task: "question" })).details.results[0];
		assert.equal(first.canResume, true, first.errorMessage);
		const prefix = await readFile(first.logPath);
		(h.ctx as any).model = { provider: "different-parent", id: "alternate" };
		const secondOutcome = await h.execute("decision", { resume: first.subagentSessionId, task: "choose B" });
		assert.equal(secondOutcome.isError, undefined, JSON.stringify(secondOutcome.content));
		const second = secondOutcome.details.results[0];
		assert.equal(second.subagentSessionId, first.subagentSessionId); assert.notEqual(second.taskId, first.taskId); assert.equal(second.logPath, first.logPath);
		assert.equal(second.canResume, true); assert.equal(JSON.parse(second.output).previousUsers, 1);
		assert.deepEqual((await readFile(second.logPath)).subarray(0, prefix.length), prefix);
		assert.ok(h.invocations[1].includes("--session")); assert.equal(h.invocations[1].includes("--session-id"), false);
		assert.equal(h.invocations[1][h.invocations[1].indexOf("--model") + 1], "offline-fixture/model");
		const duplicate = await h.execute("decision", { resume: first.subagentSessionId, task: "choose B" });
		assert.equal(duplicate.isError, true); assert.equal(h.invocations.length, 2); assert.equal((await h.manifest(first.subagentSessionId)).state, "ready");
	} finally { await h.dispose(); }
});
for (const scenario of ["missing-startup", "missing-header", "changed-model", "exit-failure"]) {
	test(`mandatory native validation rejects ${scenario} and never advertises ready`, async () => {
		const h = await setup(scenario);
		try {
			const outcome = await h.execute(scenario, { agent: "worker", task: "work" });
			assert.equal(outcome.isError, true); const result = outcome.details.results[0];
			assert.equal(result.status, "failed"); assert.equal(result.canResume, false);
			assert.equal((await h.manifest(result.subagentSessionId)).state, "blocked");
			const retry = await h.execute("must-not-spawn", { resume: result.subagentSessionId, task: "continue" });
			assert.equal(retry.isError, true); assert.equal(h.invocations.length, 1);
		} finally { await h.dispose(); }
	});
}
for (const resumable of [true, false, null, undefined]) {
	test(`removed resumable parameter (${String(resumable)}) is rejected before session allocation`, async () => {
		const h = await setup();
		try {
			const outcome = await h.execute("legacy", { agent: "worker", task: "work", resumable });
			assert.equal(outcome.isError, true); assert.equal(outcome.details.errorCode, "INVALID_DISPATCH");
			assert.match((outcome.content[0] as any).text, /resumable was removed/);
			assert.equal(h.invocations.length, 0); assert.deepEqual(await readdir(h.root), []);
		} finally { await h.dispose(); }
	});
}
for (const mode of ["single", "parallel", "chain"] as const) {
	test(`${mode} ignores unknown overrides before spawning and persists the default selection`, async () => {
		const h = await setup();
		try {
			(h.ctx as any).thinkingLevel = "high";
			const task = { agent: "worker", task: "fallback work" };
			const dispatch = mode === "single" ? task : mode === "parallel" ? { tasks: [task, task] } : { chain: [task, task] };
			const outcome = await h.execute("fallback", { ...dispatch, model: "chat-5.6-terra", thinkingLevel: "ultra" });
			assert.equal(outcome.isError, undefined, JSON.stringify(outcome.content));
			for (const args of h.invocations) {
				assert.equal(args[args.indexOf("--model") + 1], "offline-fixture/model");
				assert.equal(args[args.indexOf("--thinking") + 1], "high");
			}
			for (const result of outcome.details.results) {
				assert.equal(result.canResume, true);
				const manifest = await h.manifest(result.subagentSessionId);
				assert.equal(manifest.config.model, "offline-fixture/model");
				assert.equal(manifest.config.thinkingLevel, "high");
			}
		} finally { await h.dispose(); }
	});
}

test("valid model with unsupported thinking omits --thinking rather than applying parent thinking", async () => {
	const h = await setup();
	try {
		(h.ctx as any).thinkingLevel = "high";
		const outcome = await h.execute("selected", { agent: "worker", task: "work", provider: "offline-fixture", model: "alternate", thinkingLevel: "high" });
		assert.equal(outcome.isError, undefined, JSON.stringify(outcome.content));
		assert.equal(h.invocations[0][h.invocations[0].indexOf("--model") + 1], "offline-fixture/alternate");
		assert.equal(h.invocations[0].includes("--thinking"), false);
		const first = outcome.details.results[0];
		assert.equal((await h.manifest(first.subagentSessionId)).config.thinkingLevel, "off");
		(h.ctx as any).modelRegistry.find = () => undefined;
		const resume = await h.execute("missing-saved", { resume: first.subagentSessionId, task: "continue" });
		assert.equal(resume.isError, true); assert.equal(resume.details.errorCode, "MODEL_UNAVAILABLE");
		assert.equal(h.invocations.length, 1, "saved resume configuration must not silently fall back");
	} finally { await h.dispose(); }
});

test("model and thinking schema descriptions require user/skill opt-in and allow unknown thinking strings to reach fallback", async () => {
	const h = await setup();
	try {
		for (const key of ["model", "thinkingLevel"]) {
			assert.match(h.tool.parameters.properties[key].description, /Omit by default/);
			assert.match(h.tool.parameters.properties[key].description, /user or a skill/);
		}
		assert.equal(h.tool.parameters.properties.thinkingLevel.type, "string");
		assert.equal(h.tool.parameters.properties.thinkingLevel.enum, undefined);
		assert.ok(h.tool.promptGuidelines?.some(line => /Omit model, provider, and thinkingLevel/.test(line)));
	} finally { await h.dispose(); }
});

test("argument builder cannot fall back to a missing or ephemeral persistence configuration", () => {
	for (const persistence of [undefined, { kind: "ephemeral" }]) assert.throws(() => buildSubagentPiArgs({ taskPath: "/task", persistence } as any), /Managed session persistence is required/);
});
