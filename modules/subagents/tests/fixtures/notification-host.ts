// Isolated real Pi 1.1.0 SDK observation fixture; never contacts a provider.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as sdk from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { BackgroundJobs } from "../../extensions/subagent/background.ts";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
assert.equal(sdk.VERSION, "1.1.0");
globalThis.fetch = async () => { throw new Error("Network forbidden in offline SDK notification fixture"); };
const root = process.cwd();
const results: unknown[] = [];
for (const mode of ["streaming", "idle", "async-failure"] as const) {
	console.log(`[progress] Observing real Pi 1.1.0 notification boundary: ${mode}`);
	const agentDir = join(root, mode, "agent"), cwd = join(root, mode, "workspace");
	await mkdir(agentDir, { recursive: true }); await mkdir(cwd, { recursive: true }); await writeFile(join(agentDir, "auth.json"), "{}");
	const model: any = { id: "offline", name: "Offline", provider: "notification-offline", api: "notification-offline-api", baseUrl: "http://127.0.0.1:1/never-contacted", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	const entered = deferred(), release = deferred(), returned = deferred(), persisted = deferred(), settled = deferred(), hostFailed = deferred();
	let api!: sdk.ExtensionAPI, calls = 0, queued = 0;
	const errors: string[] = [];
	const settingsManager = sdk.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off", defaultProjectTrust: "never" });
	const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
		extensionFactories: [pi => {
			api = pi;
			pi.registerProvider(model.provider, { api: model.api, baseUrl: model.baseUrl, apiKey: "offline-not-secret", models: [model], streamSimple(m) {
				const stream = createAssistantMessageEventStream(); const invocation = ++calls;
				queueMicrotask(async () => {
					const message: any = { role: "assistant", provider: m.provider, api: m.api, model: m.id, content: [{ type: "text", text: "offline result" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, timestamp: Date.now(), stopReason: "stop" };
					stream.push({ type: "start", partial: message });
					if (mode === "streaming" && invocation === 1) { entered.resolve(); await release.promise; }
					stream.push({ type: "done", reason: "stop", message }); stream.end();
				});
				return stream;
			} });
		}] });
	await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
	const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "catalog.json"), allowModelNetwork: false, refreshOnCreate: false });
	const manager = sdk.SessionManager.create(cwd, join(root, mode, "sessions"));
	const { session } = await sdk.createAgentSession({ cwd, agentDir, settingsManager, resourceLoader: loader, sessionManager: manager, modelRuntime, model, thinkingLevel: "off", tools: [] });
	await session.bindExtensions({ mode: "json", onError: event => { errors.push(event.error); hostFailed.resolve(); } });
	const originalFollowUp = session.agent.followUp.bind(session.agent);
	// Instrument the real host queue admission, not the extension callback acknowledgment.
	session.agent.followUp = message => { originalFollowUp(message); queued++; };
	const originalSend = session.sendCustomMessage.bind(session);
	if (mode === "async-failure") session.sendCustomMessage = async () => { throw new Error("injected async host send failure"); };
	session.subscribe(event => {
		if (event.type === "message_end" && event.message.role === "custom" && (event.message as any).customType === "notification-boundary") persisted.resolve();
		if (event.type === "agent_settled") settled.resolve();
	});
	const jobs = new BackgroundJobs((kind, receipt) => api.sendMessage({ customType: "notification-boundary", content: JSON.stringify({ kind, receipt }), display: false }, { deliverAs: "followUp", triggerTurn: true }), undefined, undefined, event => { if (event.phase === "callback_returned") returned.resolve(); });
	let prompt: Promise<void> | undefined;
	try {
		if (mode === "streaming") { prompt = session.prompt("Hold one offline assistant turn."); await entered.promise; assert.equal(session.isStreaming, true); }
		const receipt = jobs.submit(manager.getSessionId(), cwd, jobs.epoch, ["worker"], async (_signal, _ids, _live, finish) => finish(0, { output: "done" }, "completed"));
		await returned.promise;
		assert.deepEqual(jobs.notificationEvidence().events.map(event => event.phase), ["callback_attempted", "callback_returned"]);
		assert.ok(jobs.notificationEvidence().events.every(event => event.hostAcknowledgment === "unknown"));
		if (mode === "streaming") {
			assert.equal(queued, 1, "actual host followUp queue admission observed");
			assert.equal(manager.getEntries().some(entry => entry.type === "custom_message"), false, "callback returned while queued, before persistence");
			release.resolve(); await prompt;
		}
		if (mode === "async-failure") {
			await hostFailed.promise;
			assert.deepEqual(errors, ["injected async host send failure"]);
			assert.equal(jobs.get(receipt.jobId, manager.getSessionId(), cwd).status, "completed", "host async rejection is not an extension sync throw");
			assert.equal(jobs.notificationEvidence().events.some(event => event.phase === "callback_threw"), false);
			assert.equal(manager.getEntries().some(entry => entry.type === "custom_message"), false);
		} else {
			await persisted.promise; await settled.promise; await session.waitForIdle();
			const entries = (await readFile(manager.getSessionFile()!, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
			assert.equal(entries.filter(entry => entry.type === "custom_message" && entry.customType === "notification-boundary").length, 1, "actual parent file persisted once");
			assert.deepEqual(errors, []);
		}
		results.push({ mode, queuedObserved: queued, persistedObserved: mode !== "async-failure", hostAsyncFailureObserved: mode === "async-failure", extensionHostAcknowledgment: "unknown", callbackAttempts: jobs.notificationEvidence().events.filter(event => event.phase === "callback_attempted").length });
	} finally {
		release.resolve(); await prompt; await jobs.shutdown();
		session.sendCustomMessage = originalSend; session.agent.followUp = originalFollowUp;
		await session.extensionRunner!.emit({ type: "session_shutdown", reason: "quit" }); session.dispose();
	}
}
console.log(JSON.stringify({ hostVersion: sdk.VERSION, status: "passed", cases: results }));
