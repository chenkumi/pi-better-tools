import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { resolveRegisteredModel, selectDispatchDefaults, type SelectionContext } from "../extensions/subagent/model-selection.ts";

const model = (provider: string, id: string, reasoning = true, thinkingLevelMap?: Model<Api>["thinkingLevelMap"]): Model<Api> => ({
	provider, id, name: id, api: "openai-responses", reasoning, thinkingLevelMap, input: ["text"],
	contextWindow: 10000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});
const parent = model("parent", "default");
const alternate = model("other", "alternate", false);
const extended = model("other", "extended", true, { xhigh: "xhigh", max: "max" });
function context(models = [parent, alternate, extended], current = parent): SelectionContext {
	return { model: current, thinkingLevel: "high", modelRegistry: {
		find: (provider, id) => models.find(m => m.provider === provider && m.id === id), getAll: () => models,
	} };
}

test("omitted or unknown model/thinking overrides use the same parent defaults", () => {
	const ctx = context();
	const defaults = selectDispatchDefaults(ctx, {});
	assert.equal(defaults.model, "parent/default"); assert.equal(defaults.thinkingLevel, "high");
	for (const requested of [{ model: "chat-5.6-terra" }, { model: "unknown/default" }, { model: "   " },
		{ thinkingLevel: "ultra" }, { thinkingLevel: "max" }, { model: "missing", thinkingLevel: "ultra" }]) {
		assert.deepEqual(selectDispatchDefaults(ctx, requested), defaults);
	}
});

test("registered bare and qualified IDs canonicalize to provider/model", () => {
	for (const selection of ["other/alternate", "alternate", " other/alternate "]) {
		const result = selectDispatchDefaults(context(), { model: selection });
		assert.equal(result.model, "other/alternate"); assert.equal(result.thinkingLevel, undefined);
	}
});

test("bare IDs prefer the current provider and otherwise require a unique exact ID", () => {
	const sharedParent = model("parent", "shared"), sharedOther = model("other", "shared");
	assert.equal(resolveRegisteredModel("shared", context([parent, sharedParent, sharedOther])), sharedParent);
	const ctx = context([parent, sharedOther, model("third", "shared")]);
	assert.equal(resolveRegisteredModel("shared", ctx), undefined);
	assert.equal(selectDispatchDefaults(ctx, { model: "shared" }).model, "parent/default");
	assert.equal(resolveRegisteredModel("altern", context()), undefined, "fuzzy guesses are not registered IDs");
});

test("provider model IDs may themselves contain a slash", () => {
	const nested = model("openrouter", "vendor/model");
	const ctx = context([parent, nested]);
	assert.equal(resolveRegisteredModel("openrouter/vendor/model", ctx), nested);
	assert.equal(resolveRegisteredModel("vendor/model", ctx), nested);
});

test("explicit provider cannot be reinterpreted as a bare ID on another provider", () => {
	const collision = model("other", "missing/target");
	const ctx = context([parent, collision]);
	assert.equal(resolveRegisteredModel("target", ctx, "missing"), undefined);
	assert.equal(selectDispatchDefaults(ctx, { provider: "missing", model: "target" }).model, "parent/default");
	assert.equal(selectDispatchDefaults(context(), { provider: "other", model: "alternate" }).model, "other/alternate");
});

test("a registered canonical provider/model takes precedence over a slash-containing bare ID", () => {
	const nested = model("openrouter", "vendor/model"), qualified = model("vendor", "model");
	const ctx = context([nested, qualified], nested);
	assert.equal(resolveRegisteredModel("vendor/model", ctx), qualified);
	assert.equal(resolveRegisteredModel("openrouter/vendor/model", ctx), nested);
});

test("thinking support is checked against the resolved override, not the parent", () => {
	const ctx = context();
	assert.equal(selectDispatchDefaults(ctx, { model: "other/alternate", thinkingLevel: "high" }).thinkingLevel, undefined);
	assert.equal(selectDispatchDefaults(ctx, { model: "other/alternate", thinkingLevel: "off" }).thinkingLevel, "off");
	assert.equal(selectDispatchDefaults(ctx, { model: "other/extended", thinkingLevel: "max" }).thinkingLevel, "max");
	assert.equal(selectDispatchDefaults(ctx, { model: "other/extended", thinkingLevel: "xhigh" }).thinkingLevel, "xhigh");
	assert.equal(selectDispatchDefaults(ctx, { model: "other/extended", thinkingLevel: "unknown" }).thinkingLevel, undefined);
});

test("an invalid model falls back first; valid thinking is then applied to that fallback", () => {
	const result = selectDispatchDefaults(context(), { model: "missing", thinkingLevel: "low" });
	assert.equal(result.model, "parent/default"); assert.equal(result.thinkingLevel, "low");
});

test("agent default takes precedence over parent when override is ignored", () => {
	const ctx = context();
	assert.equal(selectDispatchDefaults(ctx, { model: "missing", thinkingLevel: "max" }, "other/extended").thinkingLevel, "max");
	assert.equal(selectDispatchDefaults(ctx, { model: "missing" }, "alternate").model, "other/alternate");
	assert.equal(selectDispatchDefaults(ctx, {}, "alternate").thinkingLevel, undefined);
	assert.equal(selectDispatchDefaults(ctx, {}, "missing-agent-model").model, "parent/default");
	assert.equal(selectDispatchDefaults(ctx, { model: "parent/default" }, "other/extended").model, "parent/default");
});

test("metadata-disabled levels are ignored; supported explicit levels survive", () => {
	const restricted = model("parent", "restricted", true, { low: null, off: null });
	const ctx = context([restricted], restricted);
	assert.equal(selectDispatchDefaults(ctx, { thinkingLevel: "low" }).thinkingLevel, "high");
	assert.equal(selectDispatchDefaults(ctx, { thinkingLevel: "off" }).thinkingLevel, "high");
	assert.equal(selectDispatchDefaults(ctx, { thinkingLevel: "medium" }).thinkingLevel, "medium");
});

test("default inherited thinking is normalized to the final parent model", () => {
	const ctx = context([alternate], alternate);
	assert.equal(selectDispatchDefaults(ctx, {}).thinkingLevel, "off");
	assert.equal(selectDispatchDefaults(ctx, { thinkingLevel: "high" }).thinkingLevel, "off");
	assert.equal(selectDispatchDefaults(ctx, { model: "missing", thinkingLevel: "ultra" }).thinkingLevel, "off");
});

test("model registry resolution finishes before reading thinking capability", () => {
	const order: string[] = [];
	const observed = model("other", "observed");
	Object.defineProperty(observed, "reasoning", { get() { order.push("thinking"); return true; } });
	const ctx = context([parent, observed]);
	ctx.modelRegistry.find = (provider, id) => { order.push("model"); return provider === "other" && id === "observed" ? observed : undefined; };
	selectDispatchDefaults(ctx, { model: "other/observed", thinkingLevel: "high" });
	assert.deepEqual(order, ["model", "thinking"]);
});
