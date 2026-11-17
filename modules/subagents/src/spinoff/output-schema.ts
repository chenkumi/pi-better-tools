import { Type } from "typebox";

const open = { additionalProperties: true };
/** spinoff: the acceptance receipt. */
export const spinoffReceiptSchema = Type.Object({
	jobId: Type.String(), spinoffSessionId: Type.String(), status: Type.String(), title: Type.String(), transcriptPath: Type.String(), resumeHint: Type.String(),
}, open);
/** One Spinoff summary as returned by agent_status (with `result` when a single job is requested) and agent_cancel. */
export const spinoffSummarySchema = Type.Object({
	jobId: Type.String(), spinoffSessionId: Type.String(), title: Type.String(), status: Type.String(), cancelRequested: Type.Boolean(), delivery: Type.String(), model: Type.String(), thinkingLevel: Type.String(), createdAt: Type.String(),
	startedAt: Type.Optional(Type.String()), endedAt: Type.Optional(Type.String()), sessionPath: Type.Optional(Type.String()), transcript: Type.Optional(Type.Object({}, open)),
	cleanup: Type.Optional(Type.Object({}, open)), blocked: Type.Optional(Type.Object({}, open)), holdsPermit: Type.Optional(Type.Boolean()), persistError: Type.Optional(Type.String()),
	interactions: Type.Optional(Type.Array(Type.Object({ messageId: Type.String(), mode: Type.String(), status: Type.String(), sentAt: Type.String() }, open))),
	result: Type.Optional(Type.Object({}, open)), errorCode: Type.Optional(Type.String()), usage: Type.Optional(Type.Object({}, open)),
}, open);
/** agent_status: one summary (jobId given) or the bounded list. */
export const spinoffStatusOutputSchema = Type.Union([spinoffSummarySchema, Type.Object({ spinoffs: Type.Array(spinoffSummarySchema), partial: Type.Boolean() }, open)]);
/** agent_message: the delivery receipt (accepted is not applied). */
export const spinoffMessageReceiptSchema = Type.Object({
	jobId: Type.String(), spinoffSessionId: Type.String(), mode: Type.String(), messageId: Type.String(), status: Type.String(), error: Type.Optional(Type.String()),
}, open);
