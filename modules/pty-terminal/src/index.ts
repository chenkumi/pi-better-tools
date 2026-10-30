import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { decodeControlEscapes } from "./escape.ts";
import { parseEnvPolicy } from "./env.ts";
import { KEY_NAMES, resolveKeys } from "./keys.ts";
import { truncatePtyOutput, type OutputFormat } from "./output.ts";
import { DEFAULT_COLS, DEFAULT_ROWS, droppedNotice, errorText, KILL_SIGNALS, MAX_COLS, MAX_ROWS, MAX_WAIT_MS, PtySessionManager, sharedOrphanRegistry, type ReadSnapshot } from "./pty-manager.ts";
import { compileWaitFor, MAX_WAIT_FOR_LENGTH } from "./wait-for.ts";
import { resolveTarget } from "./targets.ts";
import { ptyRenderers } from "./renderers.ts";
import { SecretInput } from "./secret-input.ts";
import { MASK } from "./secret-mask.ts";
import { PtySessionsWidget, publishPtyBriefs } from "./live-widget.ts";

/** pty_read wait when nothing is pending, and the longer default when waitFor or settleMs asks for a condition. */
const DEFAULT_READ_TIMEOUT_MS = 1_000;
const CONDITIONAL_READ_TIMEOUT_MS = 5_000;
const DEFAULT_EXIT_WAIT_MS = 5_000;
/** How long pty_keyin waits for the user before giving up. */
const KEYIN_TIMEOUT_MS = 10 * 60_000;
const SECRET_WORDS = /pass(?:word|phrase|code|wd)?|密碼|密码|口令|\bpin\b|secret|token|otp|金鑰|憑證|驗證碼|验证码/i;
/** `$ # %` end a shell prompt and almost never a request for a secret, so the wording of the line (a host called passport-host) is not consulted. */
const SHELL_PROMPT_END = /[$#%]$/;
/** `> » ❯ ➜` also end some secret prompts, so those only count as a shell prompt when the line does not mention a secret. */
const AMBIGUOUS_PROMPT_END = /[>»❯➜]$/;
/** The program has left its prompt (timeout, error, exit to shell): the last line looks like a shell prompt and not like a request for a secret. */
const promptProblem = (line: string): string | undefined => SHELL_PROMPT_END.test(line) || (AMBIGUOUS_PROMPT_END.test(line) && !SECRET_WORDS.test(line))
	? `the last line of the session looks like a shell prompt, not a request for a secret: "${line.slice(-120)}". The program probably left its password prompt (timeout or error)`
	: undefined;
const oneLineText = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+/g, " ").trim();

const positiveInteger = (description: string, maximum?: number) => Type.Integer({ minimum: 1, ...(maximum ? { maximum } : {}), description });

const formatParameter = Type.Optional(Type.Union([Type.Literal("raw"), Type.Literal("text")], { description: "raw (default) keeps control sequences; text strips ANSI codes (no screen emulation)." }));

const spawnParameters = Type.Object({
	target: Type.Optional(Type.String({ description: "Named PTY target defined in the user's settings. Defaults to local; unknown targets fail." })),
	command: Type.String({ description: "Executable path or command name to run." }),
	args: Type.Optional(Type.Array(Type.String({ description: "One command argument." }), { description: "Arguments passed to the command." })),
	cwd: Type.Optional(Type.String({ description: "Working directory on the target. Local defaults to Pi cwd; remote uses configured absolute POSIX cwd." })),
	cols: Type.Optional(positiveInteger(`Terminal columns (max ${MAX_COLS}). Defaults to ${DEFAULT_COLS}.`, MAX_COLS)),
	rows: Type.Optional(positiveInteger(`Terminal rows (max ${MAX_ROWS}). Defaults to ${DEFAULT_ROWS}.`, MAX_ROWS)),
	env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Additional environment variables." })),
});

/** Every PTY tool; kept in step with the registrations below by extension.test.ts. */
export const PTY_TOOL_NAMES = ["pty_spawn", "pty_write", "pty_keyin", "pty_read", "pty_resize", "pty_wait_exit", "pty_kill", "pty_list"] as const;
// Deferred: not declared to the model until tool_search loads them (one search loads the whole namespace). Activation of
// tool_search, the fallback without it and the discovery hint are handled once for all modules by pi-runtime.
const PTY_EXPOSURE = {
	exposure: "deferred",
	namespace: { name: "pty", description: "Persistent pseudo-terminal sessions for interactive programs and TUIs on local, WSL or SSH targets." },
} as const;

export default function (pi: ExtensionAPI) {
	const sessions = new PtySessionManager({ orphans: sharedOrphanRegistry() });
	const widget = new PtySessionsWidget(pi);
	sessions.onChange = () => widget.refresh();
	let revokeBriefs: (() => void) | undefined;

	pi.registerTool({
		name: "pty_spawn",
		...PTY_EXPOSURE,
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
		const end = snapshot.start + snapshot.toRaw(snapshot.text.length - truncated.remainder.length); // masks change the text length, cursors count raw output
		if (consume) sessions.consume(sessionId, end);
		const parts: string[] = [];
		if (snapshot.dropped) parts.push(droppedNotice(snapshot.dropped).trimEnd());
		if (snapshot.masked) parts.push(`[pty-terminal: the screen contained text typed through pty_keyin (${snapshot.masked} occurrence${snapshot.masked === 1 ? "" : "s"}); it was masked as ${MASK}. The program probably did not take it as a secret: check the prompt before retrying]`);
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
				...(snapshot.masked ? { masked: snapshot.masked } : {}),
				...(snapshot.dropped ? { dropped: snapshot.dropped } : {}),
				...(snapshot.wait ? { waitFor: snapshot.wait } : {}),
				...(snapshot.exited ? { exited: true } : {}),
				...(format === "text" ? { format } : {}),
			},
		};
	}

	pi.registerTool({
		name: "pty_write",
		...PTY_EXPOSURE,
		...ptyRenderers("write"),
		label: "PTY write",
		description: "Write input to a PTY session: data (control escapes such as \\x03 for Ctrl+C, \\r for Enter, \\t for Tab; write \\\\ or \\x5c for a literal backslash, e.g. C:\\\\new or C:\\x5cnew; a lone backslash before r/n/f/t/v/x/u is otherwise decoded) and/or keys (named keys, sent after data). Optional readAfterMs waits that long after writing, then drains and returns output like pty_read.",
		promptSnippet: "pty_write: send text or named keys to a PTY session",
		parameters: Type.Object({
			sessionId: Type.String({ description: "PTY session id returned by pty_spawn." }),
			data: Type.Optional(Type.String({ description: "Text to write. Control escapes supported: \\xNN, \\uXXXX, \\r, \\n, \\t, \\f, \\v; use \\\\ or \\x5c for a literal backslash (single-pass decoding)." })),
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
				throw new Error(`${errorText(error)} (input was already written; the session is retained, use pty_read to collect output)`);
			}
			const result = deliver(params.sessionId, await sessions.readEx(params.sessionId, { timeoutMs: 0 }), params.format ?? "raw", true);
			if (!result.content[0].text) result.content[0].text = "ok";
			return result;
		},
	});

	let keyinActive = false;
	pi.registerTool({
		name: "pty_keyin",
		...PTY_EXPOSURE,
		...ptyRenderers("keyin"),
		label: "PTY key-in",
		description: "Ask the user to type a secret (for example a password at a prompt that does not echo) into a PTY session. The user sees a masked input dialog; what they type goes straight to the session with Enter appended and is never returned to you, logged or stored. You only learn whether it was sent. Use after pty_read shows the prompt; then pty_read again for the program's response. Never ask the user to put the secret in the chat.",
		promptSnippet: "pty_keyin: let the user type a password directly into a PTY session without it reaching the conversation",
		promptGuidelines: ["When a PTY program asks for a password or other secret, call pty_keyin instead of asking the user to type it in chat; do not retry it in a loop if the user cancels."],
		parameters: Type.Object({
			sessionId: Type.String({ description: "PTY session id waiting for the secret." }),
			prompt: Type.Optional(Type.String({ maxLength: 200, description: "Short text telling the user what is being asked for (shown as coming from the agent)." })),
			confirmPrompt: Type.Optional(Type.Boolean({ description: "Set true only after pty_read showed the program really is waiting for a secret although its last line looks like a shell prompt. Skips the prompt check." })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!ctx.hasUI) throw new Error("pty_keyin needs an interactive Pi UI, which this session does not have. Ask the user to run the program that needs the secret themselves; do not ask for the secret in chat.");
			if (keyinActive) throw new Error("Another pty_keyin dialog is already open; wait for the user to finish it.");
			if (signal?.aborted) throw new Error("pty_keyin aborted");
			sessions.assertWritable(params.sessionId);
			const before = params.confirmPrompt ? undefined : promptProblem(sessions.lastLine(params.sessionId));
			if (before) throw new Error(`pty_keyin was not opened: ${before}. Use pty_read to see what the program is doing; call pty_keyin again only once it asks for the secret again (or pass confirmPrompt:true if it really is waiting).`);
			const info = sessions.list().find((entry) => entry.sessionId === params.sessionId);
			const header = [params.prompt?.trim()
				? oneLineText(params.prompt)
				: `Secret input for PTY session ${params.sessionId} (target ${info?.target ?? "unknown"}, ${info?.transport ?? "unknown"} transport)`];
			keyinActive = true;
			const stop = new AbortController();
			let secret: string | undefined;
			let reason: "cancelled" | "timeout" | "aborted" | "exited" | undefined;
			try {
				const input = await new Promise<string | undefined>((resolve) => {
					let finish: (value: string | undefined) => void = resolve;
					const timer = setTimeout(() => { reason = "timeout"; finish(undefined); }, KEYIN_TIMEOUT_MS);
					timer.unref?.();
					const onAbort = () => { reason = "aborted"; finish(undefined); };
					signal?.addEventListener("abort", onAbort, { once: true });
					void (async () => { // The program may exit while the dialog is open; typing then would go nowhere.
						while (!stop.signal.aborted) {
							const exit = await sessions.waitForExit(params.sessionId, MAX_WAIT_MS, stop.signal).catch(() => undefined);
							if (exit && !exit.timedOut) { reason = "exited"; finish(undefined); return; }
							if (!exit) return;
						}
					})();
					void ctx.ui.custom<string | undefined>((tui, _theme, _keybindings, done) => {
						finish = (value) => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); resolve(value); done(value); };
						return new SecretInput({ header, requestRender: () => tui.requestRender(), onSubmit: (value) => finish(value), onCancel: () => { reason = "cancelled"; finish(undefined); } });
					}).then((value) => { if (value === undefined && !reason) reason = "cancelled"; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); resolve(value); }, () => { reason = "cancelled"; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); resolve(undefined); });
				});
				secret = input;
			} finally {
				stop.abort();
				keyinActive = false;
			}
			if (secret === undefined) {
				const why = { cancelled: "the user cancelled", timeout: "the user did not answer in time", aborted: "the tool call was aborted", exited: "the PTY session exited while waiting" }[reason ?? "cancelled"];
				return { content: [{ type: "text", text: `Nothing was sent: ${why}. Do not ask the user for the secret in chat.` }], details: { sessionId: params.sessionId, delivered: false, reason: reason ?? "cancelled" } };
			}
			// The dialog can stay open for minutes: sudo and friends give up in the meantime and hand the next line to the shell.
			let after: string | undefined;
			try {
				if (!params.confirmPrompt) { sessions.assertWritable(params.sessionId); after = promptProblem(sessions.lastLine(params.sessionId)); }
			} catch (error) {
				secret = undefined; // the session ended while the dialog was open: report that, not a write failure
				throw error;
			}
			if (after) {
				secret = undefined;
				return { content: [{ type: "text", text: `Nothing was sent: ${after}. The program stopped waiting while the dialog was open. Use pty_read, restart the command that needs the secret, then call pty_keyin again.` }], details: { sessionId: params.sessionId, delivered: false, reason: "prompt_gone" } };
			}
			try {
				sessions.write(params.sessionId, `${secret}\r`);
				sessions.addSecret(params.sessionId, secret); // same tick as the write: the echo is delivered asynchronously and masking happens at read time, so it cannot arrive unmasked; a failed write registers nothing
			} catch (error) {
				const message = errorText(error);
				throw new Error(secret ? message.split(secret).join("") : message);
			} finally {
				secret = undefined;
			}
			return { content: [{ type: "text", text: "The user entered the secret and it was sent to the session (content not visible to you). Use pty_read to see the program's response." }], details: { sessionId: params.sessionId, delivered: true } };
		},
	});

	pi.registerTool({
		name: "pty_read",
		...PTY_EXPOSURE,
		...ptyRenderers("read"),
		label: "PTY read",
		description: `Read and drain accumulated PTY output (capped at 2,000 lines/50 KiB; the rest stays buffered). If nothing is pending, waits up to timeoutMs (default ${DEFAULT_READ_TIMEOUT_MS}; ${CONDITIONAL_READ_TIMEOUT_MS} when waitFor or settleMs is set). Cancelling only stops the wait; the session stays.`,
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
				timeoutMs: params.timeoutMs ?? (waitFor || params.settleMs ? CONDITIONAL_READ_TIMEOUT_MS : DEFAULT_READ_TIMEOUT_MS),
				signal, waitFor, settleMs: params.settleMs, since: params.since, format: params.format,
			});
			return deliver(params.sessionId, snapshot, params.format ?? "raw", params.since === undefined);
		},
	});

	pi.registerTool({
		name: "pty_resize",
		...PTY_EXPOSURE,
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
		...PTY_EXPOSURE,
		...ptyRenderers("wait_exit"),
		label: "PTY wait for exit",
		description: "Wait for a PTY process to exit and return its transport exit code. On timeout returns exitCode -1 with timedOut:true. SSH exit 255 may be a connection error.",
		parameters: Type.Object({
			sessionId: Type.String({ description: "PTY session id." }),
			timeoutMs: Type.Optional(positiveInteger(`Maximum wait in milliseconds (max ${MAX_WAIT_MS}). Defaults to ${DEFAULT_EXIT_WAIT_MS}.`, MAX_WAIT_MS)),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			const result = await sessions.waitForExit(params.sessionId, params.timeoutMs ?? DEFAULT_EXIT_WAIT_MS, signal);
			const { signal: exitSignal, ...rest } = result;
			return { content: [{ type: "text", text: JSON.stringify({ ...rest, ...(exitSignal ? { signal: exitSignal } : {}) }) }], details: result };
		},
	});

	pi.registerTool({
		name: "pty_kill",
		...PTY_EXPOSURE,
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
			const text = { released: result.released, ...(result.released ? {} : { exited: result.exited }), ...(result.escalatedToSigkill ? { escalatedToSigkill: true } : {}), note: "local transport only; remote process tree not confirmed stopped", ...(result.released ? {} : { hint: `Session ${params.sessionId} is retained because the transport has not exited; call pty_kill again (optionally with signal SIGKILL on POSIX) or check pty_list.` }) };
			return { content: [{ type: "text", text: JSON.stringify(text) }], details: result };
		},
	});

	pi.registerTool({
		name: "pty_list",
		...PTY_EXPOSURE,
		...ptyRenderers("list"),
		label: "PTY list",
		description: "List active and exited PTY sessions that have not been released.",
		parameters: Type.Object({}),
		executionMode: "sequential",
		async execute() {
			const result = sessions.list();
			const text = result.map(({ sessionId, state, target, transport, bufferedBytes, droppedChars, recovered }) => ({
				sessionId, state, target, ...(recovered ? { recovered, note: "survived a failed shutdown; local transport exit unconfirmed, remote tree unknown; use pty_kill to retry" } : {}), ...(transport !== "local" ? { transport } : {}), ...(bufferedBytes ? { unreadBytes: bufferedBytes } : {}), ...(droppedChars ? { droppedChars } : {}),
			}));
			return { content: [{ type: "text", text: JSON.stringify(text) }], details: result };
		},
	});

	// A previous instance whose shutdown could not confirm transport exit parked its sessions; re-adopt them for this workspace.
	pi.on("session_start", async (_event, ctx) => {
		revokeBriefs?.(); revokeBriefs = undefined;
		try { revokeBriefs = publishPtyBriefs(sessions, ctx); } catch { /* the compaction reminder is best effort */ }
		widget.bind(ctx, () => sessions.snapshot(ctx.cwd));
		sessions.recover(ctx.cwd);
	});

	pi.on("session_shutdown", async () => {
		revokeBriefs?.(); revokeBriefs = undefined;
		widget.clear();
		const result = await sessions.shutdown();
		if (result.retained.length) throw new Error(`PTY shutdown incomplete: ${result.errors.join("; ")}. Local transport exit remains unconfirmed; sessions remain recoverable via pty_list/pty_kill after reload.`);
	});
}
