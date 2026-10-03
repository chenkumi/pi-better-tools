import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { decodeControlEscapes } from "./escape.ts";
import { truncatePtyOutput } from "./output.ts";
import { KILL_SIGNALS, MAX_COLS, MAX_ROWS, MAX_WAIT_MS, PtySessionManager } from "./pty-manager.ts";
import { resolveTarget } from "./targets.ts";
import { ptyRenderers } from "./renderers.ts";

const positiveInteger = (description: string, maximum?: number) => Type.Integer({ minimum: 1, ...(maximum ? { maximum } : {}), description });

const spawnParameters = Type.Object({
	target: Type.Optional(Type.String({ description: "Named PTY target from pi-pty-terminal.targets. Defaults to local; unknown targets fail." })),
	command: Type.String({ description: "Executable path or command name to run." }),
	args: Type.Optional(Type.Array(Type.String({ description: "One command argument." }), { description: "Arguments passed to the command." })),
	cwd: Type.Optional(Type.String({ description: "Working directory on the target. Local defaults to Pi cwd; remote uses configured absolute POSIX cwd." })),
	cols: Type.Optional(positiveInteger(`Terminal columns (max ${MAX_COLS}). Defaults to 100.`, MAX_COLS)),
	rows: Type.Optional(positiveInteger(`Terminal rows (max ${MAX_ROWS}). Defaults to 30.`, MAX_ROWS)),
	env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Additional environment variables." })),
});

export default function (pi: ExtensionAPI) {
	const sessions = new PtySessionManager();

	pi.registerTool({
		name: "pty_spawn",
		...ptyRenderers("spawn"),
		label: "PTY spawn",
		description: "Spawn a process in a persistent real pseudo-terminal on local (default) or a configured WSL/SSH target. Use for TUI programs and commands requiring a TTY. Remote sessions require pty_read to inspect connection errors.",
		promptSnippet: "pty_spawn: start a TTY-dependent process and return a session id",
		promptGuidelines: ["Use pty_spawn rather than bash for interactive/TUI programs, then control it with the other pty_* tools."],
		parameters: spawnParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("PTY spawn aborted");
			const plan = resolveTarget(params.command, params.args ?? [], params, ctx.cwd,
				params.target && params.target !== "local" ? (pi.getSettings() as unknown as Record<string, unknown>)["pi-pty-terminal"] : undefined);
			const result = sessions.spawn(plan.command, plan.args, { ...plan.options, target: plan.target, transport: plan.transport }, ctx.cwd);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});

	pi.registerTool({
		name: "pty_write",
		...ptyRenderers("write"),
		label: "PTY write",
		description: "Write input to a PTY session. Decodes control escapes such as \\x03 for Ctrl+C, \\r for Enter, and \\t for Tab.",
		promptSnippet: "pty_write: send text or control keys to a PTY session",
		parameters: Type.Object({
			sessionId: Type.String({ description: "PTY session id returned by pty_spawn." }),
			data: Type.String({ description: "Text to write. Control escapes supported: \\xNN, \\uXXXX, \\r, \\n, \\t, \\f, \\v." }),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			sessions.write(params.sessionId, decodeControlEscapes(params.data));
			return { content: [{ type: "text", text: "ok" }], details: { sessionId: params.sessionId } };
		},
	});

	pi.registerTool({
		name: "pty_read",
		...ptyRenderers("read"),
		label: "PTY read",
		description: "Read and drain accumulated PTY output. If no output is pending, waits up to timeoutMs. Output is capped at 2,000 lines or 50 KiB.",
		promptSnippet: "pty_read: collect pending output from a PTY session",
		parameters: Type.Object({
			sessionId: Type.String({ description: "PTY session id." }),
			timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_WAIT_MS, description: `Maximum wait for output in milliseconds (max ${MAX_WAIT_MS}). Defaults to 1000.` })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			const output = await sessions.read(params.sessionId, params.timeoutMs ?? 1_000, signal);
			const result = truncatePtyOutput(output);
			return {
				content: [{ type: "text", text: result.content }],
				details: { sessionId: params.sessionId, truncated: result.truncated },
			};
		},
	});

	pi.registerTool({
		name: "pty_resize",
		...ptyRenderers("resize"),
		label: "PTY resize",
		description: "Resize a PTY session's terminal dimensions.",
		parameters: Type.Object({
			sessionId: Type.String({ description: "PTY session id." }),
			cols: positiveInteger("Terminal columns.", MAX_COLS),
			rows: positiveInteger("Terminal rows.", MAX_ROWS),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			sessions.resize(params.sessionId, params.cols, params.rows);
			return { content: [{ type: "text", text: "ok" }], details: params };
		},
	});

	pi.registerTool({
		name: "pty_wait_exit",
		...ptyRenderers("wait_exit"),
		label: "PTY wait for exit",
		description: "Wait for a PTY process to exit and return its exit code. Returns exitCode -1 if the timeout expires.",
		parameters: Type.Object({
			sessionId: Type.String({ description: "PTY session id." }),
			timeoutMs: Type.Optional(positiveInteger(`Maximum wait in milliseconds (max ${MAX_WAIT_MS}). Defaults to 5000.`, MAX_WAIT_MS)),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			const result = await sessions.waitForExit(params.sessionId, params.timeoutMs ?? 5_000, signal);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});

	pi.registerTool({
		name: "pty_kill",
		...ptyRenderers("kill"),
		label: "PTY kill",
		description: "Terminate the local PTY transport; escalates to SIGKILL on POSIX if it does not exit. The session is released only once the transport exited (check released); otherwise it is retained. POSIX defaults to SIGHUP; Windows ignores the signal argument. Remote/WSL background-process termination is not guaranteed.",
		parameters: Type.Object({
			sessionId: Type.String({ description: "PTY session id." }),
			signal: Type.Optional(Type.String({ description: `POSIX signal: one of ${KILL_SIGNALS.join(", ")}. Defaults to SIGHUP; ignored on Windows.` })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			const result = await sessions.kill(params.sessionId, params.signal);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});

	pi.registerTool({
		name: "pty_list",
		...ptyRenderers("list"),
		label: "PTY list",
		description: "List active and exited PTY sessions that have not been released.",
		parameters: Type.Object({}),
		executionMode: "sequential",
		async execute() {
			const result = sessions.list();
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});

	pi.on("session_shutdown", () => {
		sessions.shutdown();
	});
}
