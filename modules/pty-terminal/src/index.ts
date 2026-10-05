import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { decodeControlEscapes } from "./escape.ts";
import { parseEnvPolicy } from "./env.ts";
import { KEY_NAMES, resolveKeys } from "./keys.ts";
import { truncatePtyOutput, type OutputFormat } from "./output.ts";
import { droppedNotice, KILL_SIGNALS, MAX_COLS, MAX_ROWS, MAX_WAIT_MS, PtySessionManager, type ReadSnapshot } from "./pty-manager.ts";
import { compileWaitFor, MAX_WAIT_FOR_LENGTH } from "./wait-for.ts";
import { resolveTarget } from "./targets.ts";
import { ptyRenderers } from "./renderers.ts";

const positiveInteger = (description: string, maximum?: number) => Type.Integer({ minimum: 1, ...(maximum ? { maximum } : {}), description });

const formatParameter = Type.Optional(Type.Union([Type.Literal("raw"), Type.Literal("text")], { description: "raw (default) keeps control sequences; text strips ANSI codes (no screen emulation)." }));

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
		description: "Spawn a process in a persistent pseudo-terminal on local (default) or a configured WSL/SSH target, for interactive programs/TUIs that need continuous input. One-off commands: use shell; long-running background work: use a shell background job. PTY gives no structured exit code. Remote sessions require pty_read to inspect connection errors.",
		promptSnippet: "pty_spawn: start a TTY-dependent process and return a session id",
		promptGuidelines: ["Use shell for one-off commands and a shell background job for long-running background work; use pty_spawn only for interactive programs/TUIs that need continuous input, then control it with the other pty_* tools. PTY has no structured exit code (pty_wait_exit reports only the local transport's exit)."],
		parameters: spawnParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("PTY spawn aborted");
			// Effective (host trust-filtered) settings: project-level values only apply when the project is trusted.
			const settings = typeof pi.getSettings === "function" ? (pi.getSettings() as unknown as Record<string, unknown>)["pi-pty-terminal"] : undefined;
			const plan = resolveTarget(params.command, params.args ?? [], params, ctx.cwd, params.target && params.target !== "local" ? settings : undefined);
			const result = sessions.spawn(plan.command, plan.args, { ...plan.options, target: plan.target, transport: plan.transport, envPolicy: parseEnvPolicy(settings) }, ctx.cwd);
			const text = { sessionId: result.sessionId, ...(result.target !== "local" ? { target: result.target } : {}) };
			return { content: [{ type: "text", text: JSON.stringify(text) }], details: result };
		},
	});

	/** Shared by pty_read and pty_write(readAfterMs): truncate, consume, and build slim model text plus details. */
	function deliver(sessionId: string, snapshot: ReadSnapshot, format: OutputFormat, consume: boolean) {
		const truncated = truncatePtyOutput(snapshot.text, { format, final: snapshot.exited });
		const end = snapshot.start + (snapshot.text.length - truncated.remainder.length);
		if (consume) sessions.consume(sessionId, end);
		const parts: string[] = [];
		if (snapshot.dropped) parts.push(droppedNotice(snapshot.dropped).trimEnd());
		if (truncated.content) parts.push(truncated.content);
		const notes: string[] = [];
		if (end > snapshot.start) notes.push(`cursor ${snapshot.start}-${end}`);
		if (snapshot.wait === "timeout") notes.push("waitFor not matched before timeout");
		if (snapshot.exited) notes.push("session exited");
		if (notes.length) parts.push(`[${notes.join("; ")}]`);
		return {
			content: [{ type: "text" as const, text: parts.join("\n") }],
			details: {
				sessionId,
				truncated: truncated.truncated,
				cursor: { from: snapshot.start, to: end },
				...(snapshot.dropped ? { dropped: snapshot.dropped } : {}),
				...(snapshot.wait ? { waitFor: snapshot.wait } : {}),
				...(snapshot.exited ? { exited: true } : {}),
				...(format === "text" ? { format } : {}),
			},
		};
	}

	pi.registerTool({
		name: "pty_write",
		...ptyRenderers("write"),
		label: "PTY write",
		description: "Write input to a PTY session: data (control escapes such as \\x03 for Ctrl+C, \\r for Enter, \\t for Tab) and/or keys (named keys, sent after data). Optional readAfterMs waits that long after writing, then drains and returns output like pty_read.",
		promptSnippet: "pty_write: send text or named keys to a PTY session",
		parameters: Type.Object({
			sessionId: Type.String({ description: "PTY session id returned by pty_spawn." }),
			data: Type.Optional(Type.String({ description: "Text to write. Control escapes supported: \\xNN, \\uXXXX, \\r, \\n, \\t, \\f, \\v." })),
			keys: Type.Optional(Type.Array(Type.String(), { description: `Named keys sent in order after data: ${KEY_NAMES.join(", ")}.` })),
			readAfterMs: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_WAIT_MS, description: `Wait this many ms after writing, then drain and return output (max ${MAX_WAIT_MS}). Omit to only write.` })),
			format: formatParameter,
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			const keys = params.keys?.length ? resolveKeys(params.keys) : "";
			if (params.data === undefined && !keys) throw new Error(`pty_write needs data and/or keys. Supported keys: ${KEY_NAMES.join(", ")}.`);
			sessions.write(params.sessionId, (params.data === undefined ? "" : decodeControlEscapes(params.data)) + keys);
			if (params.readAfterMs === undefined) return { content: [{ type: "text", text: "ok" }], details: { sessionId: params.sessionId } };
			try {
				await sessions.pause(params.sessionId, params.readAfterMs, signal);
			} catch (error) {
				throw new Error(`${error instanceof Error ? error.message : String(error)} (input was already written; the session is retained, use pty_read to collect output)`);
			}
			const result = deliver(params.sessionId, await sessions.readEx(params.sessionId, { timeoutMs: 0 }), params.format ?? "raw", true);
			if (!result.content[0].text) result.content[0].text = "ok";
			return result;
		},
	});

	pi.registerTool({
		name: "pty_read",
		...ptyRenderers("read"),
		label: "PTY read",
		description: "Read and drain accumulated PTY output (capped at 2,000 lines/50 KiB; the rest stays buffered). If nothing is pending, waits up to timeoutMs (default 1000; 5000 when waitFor or settleMs is set). Cancelling only stops the wait; the session stays.",
		promptSnippet: "pty_read: collect output from a PTY session, optionally waiting for a pattern or quiet period",
		parameters: Type.Object({
			sessionId: Type.String({ description: "PTY session id." }),
			timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_WAIT_MS, description: `Maximum total wait in milliseconds (max ${MAX_WAIT_MS}).` })),
			waitFor: Type.Optional(Type.String({ maxLength: MAX_WAIT_FOR_LENGTH, description: `JavaScript RegExp source (no slashes/flags, multiline, matched against ANSI-stripped unread output; max ${MAX_WAIT_FOR_LENGTH} chars). Returns when it matches.` })),
			settleMs: Type.Optional(positiveInteger(`Return once no new output arrived for this many ms (max ${MAX_WAIT_MS}).`, MAX_WAIT_MS)),
			format: formatParameter,
			since: Type.Optional(Type.Integer({ minimum: 0, description: "Cursor (from a previous [cursor a-b]) to re-read from without draining; output older than the buffer is reported as dropped." })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			const waitFor = params.waitFor === undefined ? undefined : compileWaitFor(params.waitFor);
			const snapshot = await sessions.readEx(params.sessionId, {
				timeoutMs: params.timeoutMs ?? (waitFor || params.settleMs ? 5_000 : 1_000),
				signal, waitFor, settleMs: params.settleMs, since: params.since, format: params.format,
			});
			return deliver(params.sessionId, snapshot, params.format ?? "raw", params.since === undefined);
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
		description: "Wait for a PTY process to exit and return its transport exit code. On timeout returns exitCode -1 with timedOut:true. SSH exit 255 may be a connection error.",
		parameters: Type.Object({
			sessionId: Type.String({ description: "PTY session id." }),
			timeoutMs: Type.Optional(positiveInteger(`Maximum wait in milliseconds (max ${MAX_WAIT_MS}). Defaults to 5000.`, MAX_WAIT_MS)),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			const result = await sessions.waitForExit(params.sessionId, params.timeoutMs ?? 5_000, signal);
			const { signal: exitSignal, ...rest } = result;
			return { content: [{ type: "text", text: JSON.stringify({ ...rest, ...(exitSignal ? { signal: exitSignal } : {}) }) }], details: result };
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
			const text = { released: result.released, ...(result.released ? {} : { exited: result.exited }), ...(result.escalatedToSigkill ? { escalatedToSigkill: true } : {}), note: "local transport only; remote process tree not confirmed stopped" };
			return { content: [{ type: "text", text: JSON.stringify(text) }], details: result };
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
			const text = result.map(({ sessionId, state, target, transport, bufferedBytes, droppedChars }) => ({
				sessionId, state, target, ...(transport !== "local" ? { transport } : {}), ...(bufferedBytes ? { unreadBytes: bufferedBytes } : {}), ...(droppedChars ? { droppedChars } : {}),
			}));
			return { content: [{ type: "text", text: JSON.stringify(text) }], details: result };
		},
	});

	pi.on("session_shutdown", () => {
		sessions.shutdown();
	});
}
