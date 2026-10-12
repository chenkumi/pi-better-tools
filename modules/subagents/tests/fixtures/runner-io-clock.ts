import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { IoGate, SUBAGENT_IO_TIMEOUT_MS } from "../../extensions/subagent/io-gate.ts";

/** Test-only clock: real preparation first, short deadline only at the injected block.
 * Preserve the original gate/promise and its actual-I/O ownership barriers.
 * Requires serial tests and IoGate.run's single synchronous deadline registration.
 */
export function installIoFaultClock(t: TestContext, labels: readonly string[], wallTimeoutMs: number) {
	const realTimeout = globalThis.setTimeout, realClear = globalThis.clearTimeout;
	const realRun = IoGate.prototype.run;
	const targets = new Set(labels);
	type Token = ReturnType<typeof setTimeout>;
	type Deadline = { fire: () => void; replacement?: Token };
	const deadlines = new Map<Token, Deadline>();
	let scope: { label: string; captured: number } | undefined;
	t.mock.method(globalThis, "setTimeout", ((callback: (...args: any[]) => void, ms: number, ...args: any[]) => {
		if (!scope || !targets.has(scope.label) || ms !== SUBAGENT_IO_TIMEOUT_MS) return realTimeout(callback, ms, ...args);
		assert.equal(scope.captured++, 0, "each targeted IoGate.run must register exactly one deadline");
		let token: Token;
		const deadline: Deadline = { fire: () => {
			if (deadlines.get(token) !== deadline) return; // Cleared or previously fired.
			deadlines.delete(token);
			realClear(token);
			if (deadline.replacement) realClear(deadline.replacement);
			callback(...args);
		} };
		token = realTimeout(deadline.fire, ms);
		deadlines.set(token, deadline);
		return token;
	}) as typeof setTimeout);
	t.mock.method(globalThis, "clearTimeout", ((token: Token) => {
		const deadline = deadlines.get(token);
		if (deadline) {
			deadlines.delete(token);
			if (deadline.replacement) realClear(deadline.replacement);
		}
		realClear(token);
	}) as typeof clearTimeout);
	t.mock.method(IoGate.prototype, "run", function<T>(this: IoGate, operation: () => Promise<T>, label: string) {
		const previous = scope;
		scope = { label, captured: 0 };
		try { return realRun.call(this, operation, label) as Promise<T>; }
		finally { scope = previous; }
	});
	return {
		arm() {
			assert.equal(deadlines.size, 1, "injected block must identify one active target deadline");
			const [token, deadline] = deadlines.entries().next().value!;
			assert.equal(deadline.replacement, undefined, "target deadline may only be armed once");
			realClear(token);
			deadline.replacement = realTimeout(deadline.fire, wallTimeoutMs);
		},
	};
}
