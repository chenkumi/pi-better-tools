// The plan of a goal as `plan_submit` delivers it (README): structured and settled. There is no open-questions field: what
// was undecided is settled in the conversation first, and the decision is kept in `decisions`. No Pi or Electron imports, so `node:test`
// can load it.
import { Type, type Static } from "typebox"
import * as Value from "typebox/value"

const text = (description: string) => Type.String({ minLength: 1, description })

export const PlanSchema = Type.Object(
  {
    title: text("Short name of the plan."),
    goal: text("The outcome the plan reaches, with its scope."),
    references: Type.Array(Type.String(), { description: "Files, documents and code the work relies on." }),
    rules: Type.Array(text("One rule."), {
      description: "What the implementation must follow in every checkpoint: conventions, commands to use, what not to touch or do (out of scope). Empty when there are none.",
    }),
    decisions: Type.Array(
      Type.Object({ question: text("What was undecided."), decision: text("What was decided."), reason: text("Why.") }, { additionalProperties: false }),
      { description: "Questions that were settled with the user before submitting; empty when there were none." },
    ),
    checkpoints: Type.Array(
      Type.Object(
        {
          title: text("The result when the checkpoint is done."),
          dependsOn: Type.Array(Type.Integer({ minimum: 1 }), { description: "Numbers (1-based, in order) of earlier checkpoints this one needs." }),
          todos: Type.Array(text("One concrete action."), { minItems: 1 }),
          verify: Type.Object(
            {
              tier: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)], { description: "1 automatic check, 2 hands-on operation, 3 static review." }),
              maxAttempts: Type.Optional(Type.Integer({ minimum: 1, description: "Defaults to 3." })),
              command: Type.Optional(Type.String({ description: "Tier 1, required there: the one command the goal runner runs in the workspace; passing is exit code 0." })),
              check: Type.Optional(Type.String({ description: "Tier 2 and 3, required there: the steps to operate, or the scope to review." })),
              expected: text("What counts as passing; written to the log with the result."),
              note: Type.Optional(Type.String({ description: "Tier 3 only, required there: what was not verified by running it, the limits, how to verify later." })),
            },
            { additionalProperties: false },
          ),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, description: "One checkpoint for a small plan." },
    ),
  },
  { additionalProperties: false },
)

export type PlanInput = Static<typeof PlanSchema>

export const DEFAULT_MAX_ATTEMPTS = 3

type CheckpointInput = PlanInput["checkpoints"][number]

/** A checkpoint as the goal runner keeps it in `plan.json`: numbered, with the default attempts filled in. */
export interface PlanCheckpoint extends Omit<CheckpointInput, "verify"> {
  index: number
  verify: Omit<CheckpointInput["verify"], "maxAttempts"> & { maxAttempts: number }
}

export interface Plan extends Omit<PlanInput, "checkpoints"> {
  checkpoints: PlanCheckpoint[]
}

export type PlanResult = { ok: true; plan: Plan } | { ok: false; errors: string[] }

/** Checks what `plan_submit` was given; the errors are written for the model, which fixes them in the conversation. */
export function validatePlan(input: unknown): PlanResult {
  const shape = [...Value.Errors(PlanSchema, input)]
  if (shape.length > 0) return { ok: false, errors: shape.map((error) => `${error.instancePath || "plan"}: ${error.message}`) }
  const given = input as PlanInput
  const errors: string[] = []
  given.checkpoints.forEach((checkpoint, at) => {
    const number = at + 1
    const where = `checkpoints[${at}] (number ${number})`
    for (const dependency of checkpoint.dependsOn) if (dependency >= number) errors.push(`${where}: dependsOn ${dependency} is not an earlier checkpoint`)
    if (new Set(checkpoint.dependsOn).size !== checkpoint.dependsOn.length) errors.push(`${where}: dependsOn lists a checkpoint twice`)
    const { tier, note, command, check } = checkpoint.verify
    if (tier === 1 && !command?.trim()) errors.push(`${where}: a Tier 1 check needs a command (the one command the goal runner runs; passing is exit code 0)`)
    if (tier !== 1 && !check?.trim()) errors.push(`${where}: a Tier ${tier} check needs the steps to operate or the scope to review in check`)
    if (tier === 3 && !note?.trim()) errors.push(`${where}: a Tier 3 review needs a note (what was not verified by running it)`)
  })
  if (errors.length > 0) return { ok: false, errors }
  const checkpoints = given.checkpoints.map((checkpoint, at) => ({ ...checkpoint, index: at + 1, verify: { ...checkpoint.verify, maxAttempts: checkpoint.verify.maxAttempts ?? DEFAULT_MAX_ATTEMPTS } }))
  return { ok: true, plan: { ...given, checkpoints } }
}
