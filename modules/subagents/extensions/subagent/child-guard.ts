import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Managed children only. Verify the child's registry/trust before its first provider request.
 * This is a configuration guard, not a boundary against hostile installed extensions.
 */
export default function (pi: ExtensionAPI) {
	const slot = globalThis as { __piSubagentsGuardExpected?: any };
	const encoded = process.env.PI_SUBAGENTS_GUARD;
	// Consume the handshake so grandchildren (tools, nested pi) cannot inherit it and run the guard themselves.
	// The parsed copy survives an extension reload inside this same child process.
	if (encoded) { slot.__piSubagentsGuardExpected = JSON.parse(encoded); delete process.env.PI_SUBAGENTS_GUARD; }
	const expected = slot.__piSubagentsGuardExpected;
	if (!expected) return;
	pi.on("session_start", (_event, ctx) => {
		let errorCode: string | undefined;
		const selected = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		const requested = expected.model as string | undefined;
		const slash = requested?.indexOf("/") ?? -1;
		const exact = requested && (slash >= 0
			? ctx.modelRegistry.find(requested.slice(0, slash), requested.slice(slash + 1))
			: ctx.model && ctx.modelRegistry.find(ctx.model.provider, requested));
		if (!ctx.model || !exact || (slash >= 0 ? selected !== requested : ctx.model.id !== requested)) errorCode = "MODEL_UNAVAILABLE";
		else if (fs.realpathSync(ctx.cwd) !== expected.cwd || ctx.sessionManager.getSessionId() !== expected.id || (expected.thinkingLevel && pi.getThinkingLevel() !== expected.thinkingLevel)) errorCode = "CONFIG_CHANGED";
		else if (typeof expected.childTrusted === "boolean" && ctx.isProjectTrusted() !== expected.childTrusted) errorCode = "TRUST_REQUIRED";
		fs.writeFileSync(expected.startupPath, JSON.stringify({ version: 1, id: ctx.sessionManager.getSessionId(), cwd: fs.realpathSync(ctx.cwd), model: selected, thinkingLevel: pi.getThinkingLevel(), childTrusted: ctx.isProjectTrusted(), errorCode }), { flag: "wx", mode: 0o600 });
		if (errorCode) {
			fs.writeSync(2, `${errorCode}: managed child startup configuration rejected before provider request\n`);
			process.exit(1);
		}
		// Pin learned defaults for the query bridge too; later child configuration
		// changes must not silently route a disposable query elsewhere.
		expected.model = selected;
		expected.thinkingLevel = pi.getThinkingLevel();
		expected.childTrusted = ctx.isProjectTrusted();
	});
}
