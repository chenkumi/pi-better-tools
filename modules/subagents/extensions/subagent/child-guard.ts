import * as fs from "node:fs";
import { VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { consumeManagedChildGuard } from "../../../shell-tools/src/managed-child.ts";
import { verifyStartupReceipt } from "./child-startup-receipt.ts";

/** Managed children only. Verify the child's registry/trust before its first provider request.
 * This is a configuration guard, not a boundary against hostile installed extensions.
 */
export default function (pi: ExtensionAPI) {
	// Shell may load before this guard. Both consume the same explicit handshake
	// and retain its process-local copy across reload, never via inherited env.
	const expected = consumeManagedChildGuard();
	if (!expected) return;
	// RPC diagnostics only. This IPC report never replaces the on-disk guard or native identity checks.
	const observe = (phase: string, errorCode?: string) => {
		if (!expected.bridgeToken || !process.send || !process.connected) return;
		try { process.send({ channel: "pi-subagent-startup", token: expected.bridgeToken, phase, piVersion: VERSION, nodeVersion: process.version, ...(errorCode ? { errorCode } : {}) }, () => {}); } catch { /* diagnostics cannot change guard outcome */ }
	};
	observe("guard_loaded");
	pi.on("session_start", (_event, ctx) => {
		observe("guard_session_start");
		let errorCode: string | undefined, failure: unknown, failed = false;
		let selected: string | undefined;
		try {
			selected = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const requested = expected.model as string | undefined;
			const slash = requested?.indexOf("/") ?? -1;
			const exact = requested && (slash >= 0
				? ctx.modelRegistry.find(requested.slice(0, slash), requested.slice(slash + 1))
				: ctx.model && ctx.modelRegistry.find(ctx.model.provider, requested));
			if (!ctx.model || !exact || (slash >= 0 ? selected !== requested : ctx.model.id !== requested)) errorCode = "MODEL_UNAVAILABLE";
			else if (fs.realpathSync(ctx.cwd) !== expected.cwd || ctx.sessionManager.getSessionId() !== expected.id || (expected.thinkingLevel && pi.getThinkingLevel() !== expected.thinkingLevel)) errorCode = "CONFIG_CHANGED";
			else if (typeof expected.childTrusted === "boolean" && ctx.isProjectTrusted() !== expected.childTrusted) errorCode = "TRUST_REQUIRED";
			verifyStartupReceipt(expected, { version: 1, id: ctx.sessionManager.getSessionId(), cwd: fs.realpathSync(ctx.cwd), model: selected, thinkingLevel: pi.getThinkingLevel(), childTrusted: ctx.isProjectTrusted(), errorCode }, !errorCode);
		} catch (error) { failure = error; failed = true; }
		// Pi reports ordinary session_start exceptions and continues. Configuration
		// rejection must not be masked by receipt I/O, nor may an ownership/write
		// failure continue to any provider admission. These are real process exits,
		// not a claim that throwing from a host event handler stops the host.
		if (errorCode) {
			observe("guard_rejected", errorCode);
			try { fs.writeSync(2, `${errorCode}: managed child startup configuration rejected before provider request\n`); } catch { /* diagnostic I/O cannot bypass exit */ }
			process.exit(1);
			return;
		}
		if (failed) {
			let code = "OTHER";
			try {
				const candidate = (failure as NodeJS.ErrnoException)?.code;
				if (typeof candidate === "string" && ["EACCES", "EPERM", "EEXIST", "ENOENT", "ENOTDIR", "EIO"].includes(candidate)) code = candidate;
			} catch { /* a diagnostic getter must not replace the original exception */ }
			observe("guard_failed", code);
			try { fs.writeSync(2, `${code}: managed child startup receipt verification failed before provider request\n`); } catch { /* diagnostic I/O cannot bypass exit */ }
			process.exit(1);
			throw failure; // Original error is still observable if a unit fixture intercepts exit.
		}
		// Pin learned defaults for the query bridge too; later child configuration
		// changes must not silently route a disposable query elsewhere.
		expected.model = selected;
		expected.thinkingLevel = pi.getThinkingLevel();
		expected.childTrusted = ctx.isProjectTrusted();
		observe("guard_verified");
	});
}
