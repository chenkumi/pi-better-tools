export const SUBAGENT_RULES_SECTION = "subagent_rules";

/** Delegation rule for `subagent`; present only while the tool is active. */
export function renderSubagentRules(active: ReadonlySet<string>): string | undefined {
	if (!active.has("subagent")) return undefined;
	return "**Delegate deliberately**\n" +
		"- `subagent` for self-contained or parallel work in a fresh context: state the goal, scope, constraints and the result format you need; start independent ones in the same turn so they run in parallel. Do quick or tightly coupled work yourself.\n" +
		"- Delegated output is a claim, not proof: check the key facts before relying on it. Do not delegate work you have not scoped, and do not start overlapping workers on the same files.";
}
