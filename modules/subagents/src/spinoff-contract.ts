// The surface of Subagents that Spinoff builds on (process-tree kill, Pi launcher, RPC pipe, query snapshot helpers,
// readable transcript records). Spinoff imports only this file; changing an export here means changing Spinoff.
export { killProcessTree } from "../extensions/subagent/concurrency.ts";
export { getPiInvocation } from "../extensions/subagent/pi-invocation.ts";
export { RpcPipe } from "../extensions/subagent/rpc.ts";
export { controlId, controlText, messageText, validateInteraction } from "../extensions/subagent/query-snapshot.ts";
export {
	SubsessionWriter, readableText, serializeAssistantContent, serializeToolResultContent,
	type ReadableRecord, type SubsessionStatus,
} from "../extensions/subagent/subsession-log.ts";
export { buildSubagentPiArgs } from "../extensions/subagent/child-args.ts";
