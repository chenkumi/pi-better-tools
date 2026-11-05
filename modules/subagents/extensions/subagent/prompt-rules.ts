export const SUBAGENT_RULES_SECTION = "subagent_rules";

/** Delegation rule for `subagent`; present only while the tool is active. */
export function renderSubagentRules(active: ReadonlySet<string>): string | undefined {
	if (!active.has("subagent")) return undefined;
	return "**Delegate deliberately**\n" +
		"- Do quick or tightly coupled work yourself; delegate only self-contained or parallel work.\n" +
		"- Delegated output is a claim, not proof: check the key facts before relying on it. Do not delegate work you have not scoped.";
}
