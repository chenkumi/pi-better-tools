/** Process-wide invocation admission, including preflight and extension reloads.
 * The runner's disk writer lock remains the authoritative I/O ownership barrier.
 */
import { SessionError } from "./session-store.ts";
const key = Symbol.for("pi-better-tools.subagents.message-reservations");
const registry = globalThis as typeof globalThis & { [key]?: Set<string> };
const reservations = registry[key] ??= new Set<string>();
export function reserveContinuation(root: string, id: string): () => void {
	const identity = JSON.stringify([root, id]);
	if (reservations.has(identity)) throw new SessionError("SESSION_BUSY", "Continuation preflight/invocation already reserved; no cross-invocation message queue. Wait for task_result, then submit a new instruction.");
	reservations.add(identity);
	let released = false;
	return () => { if (!released) { released = true; reservations.delete(identity); } };
}
