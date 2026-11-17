export const SPINOFF_RULES_SECTION = "spinoff_rules";

/** Delegation rule for `spinoff`; present only while the tool is active. */
export function renderSpinoffRules(active: ReadonlySet<string>): string | undefined {
	if (!active.has("spinoff")) return undefined;
	return "**Delegate deliberately**\n" +
		"- Do quick or tightly coupled work yourself. A spinoff's result is a claim, not proof: check the key facts before relying on it.";
}
