export const FORK_RULES_SECTION = "fork_rules";

/** Delegation rule for `fork`; present only while the tool is active. */
export function renderForkRules(active: ReadonlySet<string>): string | undefined {
	if (!active.has("fork")) return undefined;
	return "**Delegate deliberately**\n" +
		"- `fork` for long work that needs this whole conversation's context. Do quick or tightly coupled work yourself.\n" +
		"- Delegated output is a claim, not proof: check the key facts before relying on it. Do not delegate work you have not scoped, and do not start overlapping workers on the same files.";
}
