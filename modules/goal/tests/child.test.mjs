// The real goal host (child.ts) against Pi's faux model: scripted replies, no network. A goal runs its checkpoint in an SDK session with a
// session file under the goal's folder, the Tier 1 command checks the result, and a review session cannot write.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const home = realpathSync.native(mkdtempSync(join(tmpdir(), "goal-child-")));
const agent = join(home, "agent"), proj = join(home, "proj");
mkdirSync(agent, { recursive: true });
mkdirSync(proj, { recursive: true });
writeFileSync(join(agent, "auth.json"), "{}");
Object.assign(process.env, { PI_CODING_AGENT_DIR: agent, HOME: home, USERPROFILE: home });
after(() => { try { rmSync(home, { recursive: true, force: true }); } catch { /* a locked file on Windows */ } });

const sdk = await import("@earendil-works/pi-coding-agent");
const ai = await import("@earendil-works/pi-ai");
const { createGoalHost } = await import("../src/child.ts");
const { GoalRunner } = await import("../src/runner.ts");
const { createGoal, loadGoal } = await import("../src/store.ts");
const { validatePlan } = await import("../src/plan.ts");

const faux = ai.fauxProvider({ models: [{ id: "m1" }] });
const runtime = await sdk.ModelRuntime.create({ authPath: join(agent, "auth.json"), modelsPath: null, refreshOnCreate: false });
runtime.registerNativeProvider(faux.provider);
await runtime.setRuntimeApiKey(faux.getModel().provider, "faux-key");
for (let i = 0; i < 500 && !runtime.getAvailableSnapshot().some((model) => model.provider === faux.getModel().provider); i++) await new Promise((resolve) => setTimeout(resolve, 10));

const ctx = { cwd: proj, model: faux.getModel(), modelRegistry: { runtime }, isProjectTrusted: () => true };
const exists = (file) => `node -e "process.exit(require('fs').existsSync('${file}') ? 0 : 1)"`;
const plan = (verify) => {
	const checked = validatePlan({ title: "t", goal: "g", references: [], rules: [], decisions: [], checkpoints: [{ title: "make a", dependsOn: [], todos: ["write a.txt"], verify }] });
	assert.ok(checked.ok);
	return checked.plan;
};
const write = (path) => ai.fauxAssistantMessage([ai.fauxToolCall("write", { path, content: "x" })], { stopReason: "toolUse" });

describe("goal host on the Pi SDK", () => {
	it("implements a checkpoint in a session of its own and passes it with the command", async () => {
		const { dir } = await createGoal(proj, plan({ tier: 1, command: exists("a.txt"), expected: "a.txt exists" }));
		faux.setResponses([write("a.txt"), ai.fauxAssistantMessage("wrote a.txt")]);
		const record = await new GoalRunner(createGoalHost(() => ctx, () => "off")).start(dir);
		assert.equal(record.status, "done");
		assert.ok(existsSync(join(proj, "a.txt")));
		assert.ok(readdirSync(join(dir, "sessions")).some((name) => name.endsWith(".jsonl")), "the session file is kept in the goal's folder");
		assert.match((await loadGoal(dir)).record.checkpoints[0].log.join("\n"), /exit code 0/);
	});

	it("fails the attempt when the command does not pass", async () => {
		const { dir } = await createGoal(proj, plan({ tier: 1, command: exists("never.txt"), expected: "never.txt exists", maxAttempts: 1 }));
		faux.setResponses([ai.fauxAssistantMessage("did nothing")]);
		const record = await new GoalRunner(createGoalHost(() => ctx, () => "off")).start(dir);
		assert.equal(record.status, "blocked");
		assert.equal(record.checkpoints[0].status, "failed");
	});

	it("reviews in a session that can only read", async () => {
		const { dir } = await createGoal(proj, plan({ tier: 3, check: "read b.txt", expected: "b.txt is right", note: "not run" }));
		faux.setResponses([write("b.txt"), ai.fauxAssistantMessage("wrote b.txt"), write("evil.txt"), ai.fauxAssistantMessage("Looks right.\nVERDICT: PASS")]);
		const record = await new GoalRunner(createGoalHost(() => ctx, () => "off")).start(dir);
		assert.equal(record.status, "done");
		assert.ok(existsSync(join(proj, "b.txt")));
		assert.ok(!existsSync(join(proj, "evil.txt")), "the reviewer's write was refused");
		assert.match(record.checkpoints[0].log.join("\n"), /Reviewed, not run: PASS/);
	});

	it("counts a model that fails as a failed attempt", async () => {
		const { dir } = await createGoal(proj, plan({ tier: 1, command: exists("c.txt"), expected: "c.txt exists", maxAttempts: 1 }));
		faux.setResponses([ai.fauxAssistantMessage([], { stopReason: "error", errorMessage: "provider down" })]);
		const record = await new GoalRunner(createGoalHost(() => ctx, () => "off")).start(dir);
		assert.equal(record.checkpoints[0].status, "failed");
		assert.match(record.checkpoints[0].log.join("\n"), /did not complete[\s\S]*provider down/);
	});

	it("stops the session when the goal is cancelled", async () => {
		const { dir } = await createGoal(proj, plan({ tier: 1, command: exists("d.txt"), expected: "d.txt exists" }));
		let started;
		const began = new Promise((resolve) => (started = resolve));
		faux.setResponses([async () => { started(); await new Promise((resolve) => setTimeout(resolve, 300)); return ai.fauxAssistantMessage("late"); }]);
		const runner = new GoalRunner(createGoalHost(() => ctx, () => "off"));
		const run = runner.start(dir);
		await began;
		const record = await runner.cancel(dir);
		assert.equal(record.status, "cancelled");
		assert.equal((await run).status, "cancelled");
	});
});
