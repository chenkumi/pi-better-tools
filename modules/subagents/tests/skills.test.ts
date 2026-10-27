import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeDispatch, taskEnvelopeError } from "../extensions/subagent/index.ts";
import { buildSkillBlock, resolveSkillBlock, taskPromptText } from "../extensions/subagent/skills.ts";

async function withSkills<T>(files: Record<string, string>, run: (commands: Array<{ name: string; source: string; sourceInfo: { path: string } }>) => Promise<T>): Promise<T> {
	const root = await mkdtemp(join(tmpdir(), "subagent-skills-"));
	try {
		const commands = [];
		for (const [name, content] of Object.entries(files)) {
			await mkdir(join(root, name), { recursive: true });
			const path = join(root, name, "SKILL.md");
			await writeFile(path, content, "utf8");
			commands.push({ name: `skill:${name}`, source: "skill", sourceInfo: { path } });
		}
		commands.push({ name: "review", source: "prompt", sourceInfo: { path: join(root, "review.md") } });
		return await run(commands);
	} finally { await rm(root, { recursive: true, force: true }); }
}

test("buildSkillBlock embeds only the SKILL.md body without frontmatter", () => {
	const block = buildSkillBlock("demo", "/skills/demo/SKILL.md", "---\nname: demo\ndescription: d\n---\n\n# Demo\nDo the thing.\n");
	assert.match(block, /^<skill name="demo" location="\/skills\/demo\/SKILL\.md">/);
	assert.match(block, /# Demo\nDo the thing\./);
	assert.equal(block.includes("description: d"), false);
	assert.match(block, /<\/skill>$/);
});

test("resolveSkillBlock reads named skills in order and ignores non-skill commands", async () => {
	await withSkills({ alpha: "---\nname: alpha\n---\nALPHA", beta: "---\nname: beta\n---\nBETA" }, async commands => {
		const block = await resolveSkillBlock(["beta", "alpha"], commands);
		assert.ok(block);
		assert.ok(block.indexOf("BETA") < block.indexOf("ALPHA"));
		await assert.rejects(resolveSkillBlock(["review"], commands), /Unknown skill: "review".*Available skills: "alpha", "beta"/);
		assert.equal(await resolveSkillBlock(undefined, commands), undefined);
		assert.equal(await resolveSkillBlock([], commands), undefined);
	});
});

test("resolveSkillBlock accepts the skill: command prefix and rejects duplicates", async () => {
	await withSkills({ alpha: "ALPHA" }, async commands => {
		assert.match((await resolveSkillBlock(["skill:alpha"], commands))!, /name="alpha"/);
		await assert.rejects(resolveSkillBlock(["alpha", "skill:alpha"], commands), /duplicate/i);
	});
});

test("taskPromptText puts the skill block before the Task line", () => {
	assert.equal(taskPromptText("do it"), "Task: do it");
	assert.equal(taskPromptText("do it", "<skill/>"), "<skill/>\n\nTask: do it");
});

test("taskEnvelopeError counts the embedded skills", () => {
	assert.equal(taskEnvelopeError("small"), undefined);
	assert.match(taskEnvelopeError("small", "x".repeat(8 * 1024 * 1024))!, /bytes after JSON encoding/);
});

test("normalizeDispatch validates skills on single and per item, not at top level for tasks/chain", () => {
	assert.equal(normalizeDispatch({ agent: "a", task: "t", skills: ["x"] }), "single");
	assert.equal(normalizeDispatch({ tasks: [{ agent: "a", task: "t", skills: ["x"] }] }), "parallel");
	assert.equal(normalizeDispatch({ chain: [{ agent: "a", task: "t", skills: ["x"] }] }), "chain");
	assert.throws(() => normalizeDispatch({ agent: "a", task: "t", skills: "x" as any }), /skills must be an array of non-blank strings/);
	assert.throws(() => normalizeDispatch({ agent: "a", task: "t", skills: [" "] }), /skills must be an array of non-blank strings/);
	assert.throws(() => normalizeDispatch({ tasks: [{ agent: "a", task: "t", skills: [1 as any] }] }), /tasks\[0\]\.skills must be an array of non-blank strings/);
	assert.throws(() => normalizeDispatch({ tasks: [{ agent: "a", task: "t" }], skills: ["x"] }), /top-level skills.*single mode/i);
});

test("createPromptFiles writes the skill block ahead of the task and keeps the system prompt separate", async () => {
	const { IoGate } = await import("../extensions/subagent/io-gate.ts");
	const { createPromptFiles, removePromptFiles } = await import("../extensions/subagent/prompt-files.ts");
	const { readFile } = await import("node:fs/promises");
	const files = await createPromptFiles("worker", "system", "do it", new IoGate(), undefined, undefined, "<skill/>");
	try {
		assert.equal(await readFile(files.taskPath, "utf8"), "<skill/>\n\nTask: do it");
		assert.equal(await readFile(files.filePath, "utf8"), "system");
	} finally { await removePromptFiles(files); }
});
