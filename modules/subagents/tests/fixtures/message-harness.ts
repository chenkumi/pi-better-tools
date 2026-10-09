import assert from "node:assert/strict";
/** Event-driven completion observer; subscribe before tool acceptance, never poll or sleep. */
export function messageHarness() {
	const notices: any[] = [], waiters: (() => void)[] = [];
	const sendMessage = (message: any) => { notices.push(message.details); for (const resolve of waiters.splice(0)) resolve(); };
	async function completion(jobId: string) {
		for (;;) { const found = notices.find(n => n.kind === "task_result" && n.jobId === jobId); if (found) return found; await new Promise<void>(resolve => waiters.push(resolve)); }
	}
	async function message(tool: any, id: string, args: any, ctx: any) {
		const receipt = await tool.execute(id, args, undefined, undefined, ctx);
		if (receipt.isError) return receipt;
		assert.equal(receipt.details.action, "resume"); assert.equal(receipt.details.status, "accepted"); assert.equal(receipt.usage, undefined);
		assert.equal(receipt.details.subagentSessionId, args.subagentSessionId);
		const notice = await completion(receipt.details.jobId), result = notice.tasks[0].result;
		return { ...receipt, isError: notice.status === "completed" ? undefined : true, details: { ...receipt.details, results: [result], errorCode: result.errorCode } };
	}
	return { sendMessage, message, completion, notices };
}
