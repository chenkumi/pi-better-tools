import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";

interface ModelRegistry {
	find(provider: string, id: string): Model<Api> | undefined;
	getAll(): Model<Api>[];
}

export interface SelectionContext {
	model?: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	modelRegistry: ModelRegistry;
}

/** Exact IDs only. Never guess a provider for an ambiguous bare ID. */
export function resolveRegisteredModel(selection: string | undefined, ctx: SelectionContext, provider?: string): Model<Api> | undefined {
	const value = selection?.trim();
	if (!value) return undefined;
	// An explicit provider must never be reinterpreted as part of a bare model ID.
	if (provider !== undefined) return ctx.modelRegistry.find(provider, value);
	const slash = value.indexOf("/");
	if (slash > 0) {
		const qualified = ctx.modelRegistry.find(value.slice(0, slash), value.slice(slash + 1));
		if (qualified) return qualified;
	}
	// Some providers (e.g. OpenRouter) have slashes inside their bare model IDs.
	const sameProvider = ctx.model && ctx.modelRegistry.find(ctx.model.provider, value);
	if (sameProvider) return sameProvider;
	const matches = ctx.modelRegistry.getAll().filter(model => model.id === value);
	return matches.length === 1 ? matches[0] : undefined;
}

/** Resolve model first, then validate thinking against that final model, before spawning. */
export function selectDispatchDefaults(
	ctx: SelectionContext,
	requested: { provider?: string; model?: string; thinkingLevel?: string },
	agentModel?: string,
) {
	const override = resolveRegisteredModel(requested.model, ctx, requested.provider);
	const agentDefault = override ? undefined : resolveRegisteredModel(agentModel, ctx);
	const selected = override ?? agentDefault ?? ctx.model;
	// Preserve the existing default: inherit parent thinking only when inheriting
	// its model. Otherwise omit --thinking and let child Pi choose its default.
	const defaultThinking = !override && !agentDefault && selected && ctx.thinkingLevel
		? clampThinkingLevel(selected, ctx.thinkingLevel) : undefined;
	const thinkingLevel = selected && requested.thinkingLevel !== undefined &&
		getSupportedThinkingLevels(selected).includes(requested.thinkingLevel as ThinkingLevel)
		? requested.thinkingLevel as ThinkingLevel : defaultThinking;
	return {
		model: selected ? `${selected.provider}/${selected.id}` : undefined,
		thinkingLevel,
		// The runner must use the validated, canonical selection, not the raw agent ID.
		modelWasExplicit: true,
		thinkingLevelWasExplicit: thinkingLevel !== undefined,
	};
}
