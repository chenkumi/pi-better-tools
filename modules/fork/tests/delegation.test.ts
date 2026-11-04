import assert from "node:assert/strict";
import test from "node:test";
import { DELEGATION_ENTRY_TYPE, DELEGATION_GUIDANCE, DELEGATION_SECTION, delegationEnabled, promptedDelegation, readDelegation, registerDelegationCommand, registerDelegationPrompt, setDelegationEnabled } from "../src/delegation.ts";
import { FORK_MARKER_TYPE } from "../src/identity.ts";
import { FORK_PROMPT_PREFIX } from "../src/manager.ts";

const marker = { type: "custom", customType: FORK_MARKER_TYPE };
const choice = (enabled: boolean) => ({ type: "custom", customType: DELEGATION_ENTRY_TYPE, data: { enabled } });

function promptHarness(active: string[], wanted: (ctx: any) => boolean) {
	const handlers = new Map<string, Function>();
	registerDelegationPrompt({ on: (name: string, h: Function) => handlers.set(name, h), getActiveTools: () => active } as any, wanted);
	return (options: Record<string, unknown> = {}) => {
		const event: any = { systemPrompt: "BASE", systemPromptOptions: { sections: {}, ...options } };
		const result = handlers.get("before_agent_start")!(event, { sessionManager: { getEntries: () => [] } });
		return { event, result };
	};
}

test("the guidance names the Fork identity cue that the Fork's own prompt opens with", () => {
	assert.ok(DELEGATION_GUIDANCE.includes(`"${FORK_PROMPT_PREFIX.replace(/\.$/, "")}`), "child recognises itself by the same words the launch prompt starts with");
	assert.match(DELEGATION_GUIDANCE, /you ARE that Fork/);
});

test("the persisted choice is the latest entry; nothing means off", () => {
	assert.equal(readDelegation([]), false);
	assert.equal(readDelegation([choice(true)]), true);
	assert.equal(readDelegation([choice(true), { type: "message" }, choice(false)]), false);
	assert.equal(readDelegation([{ type: "custom", customType: DELEGATION_ENTRY_TYPE, data: { enabled: "yes" } }]), false, "only a real boolean true enables");
});

test("the section exists only while wanted and the fork tool is active, and the prompted state follows it", () => {
	let want = false;
	const run = promptHarness(["read", "fork"], () => want);
	let { event, result } = run();
	assert.equal(event.systemPromptOptions.sections[DELEGATION_SECTION], undefined, "off: the prompt is exactly what it is without this feature");
	assert.equal(promptedDelegation(), false); assert.equal(result, undefined);
	want = true;
	({ event } = run());
	assert.equal(event.systemPromptOptions.sections[DELEGATION_SECTION], DELEGATION_GUIDANCE);
	assert.equal(promptedDelegation(), true);
	want = false;
	const stale: any = { systemPrompt: "BASE", systemPromptOptions: { sections: { [DELEGATION_SECTION]: DELEGATION_GUIDANCE } } };
	promptHarness(["read", "fork"], () => false);
	const staleHandlers = new Map<string, Function>();
	registerDelegationPrompt({ on: (n: string, h: Function) => staleHandlers.set(n, h), getActiveTools: () => ["read", "fork"] } as any, () => false);
	staleHandlers.get("before_agent_start")!(stale, {});
	assert.equal(stale.systemPromptOptions.sections[DELEGATION_SECTION], undefined, "a later run removes a section an earlier run left");
	const noTool = promptHarness(["read"], () => true)();
	assert.equal(noTool.event.systemPromptOptions.sections[DELEGATION_SECTION], undefined, "no fork tool, nothing to prefer");
	assert.equal(promptedDelegation(), false);
});

test("a forced prompt from another extension keeps the guidance in step", () => {
	let want = true;
	const handlers = new Map<string, Function>();
	registerDelegationPrompt({ on: (n: string, h: Function) => handlers.set(n, h), getActiveTools: () => ["fork"] } as any, () => want);
	const fire = (systemPrompt: string) => handlers.get("before_agent_start")!({ systemPrompt, systemPromptOptions: { sections: {}, forceSystemPrompt: "FORCED" } }, {});
	assert.deepEqual(fire("FORCED"), { systemPrompt: `FORCED

${DELEGATION_GUIDANCE}` });
	want = false;
	assert.deepEqual(fire(`FORCED

${DELEGATION_GUIDANCE}`), { systemPrompt: "FORCED" }, "switching off removes the copy appended earlier");
	assert.equal(fire("FORCED"), undefined, "nothing to change");
});

function commandHarness(entries: unknown[] = []) {
	let handler!: (args: string, ctx: any) => Promise<void>;
	const appended: Array<[string, unknown]> = [], notes: Array<[string, string]> = [];
	registerDelegationCommand({ registerCommand: (_n: string, c: any) => { handler = c.handler; }, appendEntry: (t: string, d: unknown) => appended.push([t, d]) } as any);
	const ctx = { hasUI: true, sessionManager: { getEntries: () => entries }, ui: { notify: (text: string, level: string) => notes.push([text, level]) } };
	return { run: (args: string) => handler(args, ctx), appended, notes };
}

test("/fork:delegate switches on and off, persists only real changes, and reports without args", async () => {
	setDelegationEnabled(false);
	const h = commandHarness();
	await h.run("");
	assert.match(h.notes.at(-1)![0], /Fork delegation: off/);
	await h.run("on");
	assert.equal(delegationEnabled(), true);
	assert.deepEqual(h.appended, [[DELEGATION_ENTRY_TYPE, { enabled: true }]]);
	await h.run("ON");
	assert.equal(h.appended.length, 1, "no entry when nothing changed");
	await h.run("off");
	assert.equal(delegationEnabled(), false);
	assert.deepEqual(h.appended.at(-1), [DELEGATION_ENTRY_TYPE, { enabled: false }]);
	await h.run("maybe");
	assert.equal(h.notes.at(-1)![1], "warning");
	assert.equal(delegationEnabled(), false, "an unknown argument changes nothing");
});

test("a Fork conversation cannot switch delegation on", async () => {
	setDelegationEnabled(false);
	const h = commandHarness([marker]);
	await h.run("on");
	assert.equal(delegationEnabled(), false);
	assert.deepEqual(h.appended, []);
	assert.match(h.notes.at(-1)![0], /unavailable in a Fork conversation/);
});
