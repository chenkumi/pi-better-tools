import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as path from "node:path";

// How a child Pi process is launched. Kept apart from index.ts so Fork can use it without loading the whole Subagent extension.

function resolvePiCliFromPackage(): string | undefined {
	try {
		const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
		let dir = path.dirname(entry);
		for (let depth = 0; depth < 6; depth++, dir = path.dirname(dir)) {
			const manifest = path.join(dir, "package.json");
			if (!fs.existsSync(manifest)) continue;
			const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as { name?: string; bin?: string | Record<string, string> };
			if (parsed.name !== "@earendil-works/pi-coding-agent") continue;
			const bin = typeof parsed.bin === "string" ? parsed.bin : parsed.bin?.pi;
			const cli = bin ? path.resolve(dir, bin) : undefined;
			return cli && fs.existsSync(cli) ? cli : undefined;
		}
	} catch { /* not resolvable (compiled binary, bundled host): use the fallbacks */ }
	return undefined;
}

export interface PiInvocationHost {
	execPath: string;
	argv1: string | undefined;
	packagedCli: () => string | undefined;
	/** Launch the very script the host runs instead of the pi-coding-agent package resolved from this module.
	 *  Fork needs the same Pi install as its parent: the system prompt embeds install paths, so another install means another cached prefix. */
	preferHostScript?: boolean;
}

/** Bun's embedded entry: `/$bunfs/root/...` on POSIX, `B:/~BUN/root/...` on Windows. */
function isBunVirtualScript(script: string | undefined): boolean {
	return !!script && (script.startsWith("/$bunfs/root/") || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(script));
}

/**
 * Order: PI_SUBAGENTS_PI_CLI override, a compiled Bun host (Pi-Bolt) running itself, the host-provided pi-coding-agent bin,
 * process.argv[1], then `pi` on PATH. A compiled host is not a script runner, so a package cli.js must not be passed to it.
 */
export function getPiInvocation(
	args: string[],
	env: NodeJS.ProcessEnv = process.env,
	hostOverride: Partial<PiInvocationHost> = {},
): { command: string; args: string[] } {
	const host: PiInvocationHost = { execPath: process.execPath, argv1: process.argv[1], packagedCli: resolvePiCliFromPackage, ...hostOverride };
	const override = env.PI_SUBAGENTS_PI_CLI?.trim();
	if (override) {
		if (/\.(?:[cm]?js|ts)$/i.test(override)) return { command: host.execPath, args: [override, ...args] };
		return { command: override, args };
	}
	if (isBunVirtualScript(host.argv1)) return { command: host.execPath, args };
	if (host.preferHostScript && host.argv1 && fs.existsSync(host.argv1)) return { command: host.execPath, args: [host.argv1, ...args] };
	const packaged = host.packagedCli();
	if (packaged) return { command: host.execPath, args: [packaged, ...args] };
	const currentScript = host.argv1;
	if (currentScript && fs.existsSync(currentScript)) {
		return { command: host.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(host.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: host.execPath, args };
	return { command: "pi", args };
}
