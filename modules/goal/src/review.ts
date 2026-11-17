// Tier 3 of a plan (README): a static review by a session that can only read. It judges the work against what the checkpoint
// said it must be, never runs anything, and ends with one verdict line that the goal runner reads.
import type { Plan, PlanCheckpoint } from "./plan.ts"

/** The tools a reviewer gets: reading and searching only. Whatever of these a session has registered is kept. */
export const REVIEW_TOOLS = ["read", "grep", "find", "ls"]

export function reviewPrompt(plan: Plan, checkpoint: PlanCheckpoint, summary: string): string {
  const { verify } = checkpoint
  const lines = [
    `You are reviewing checkpoint ${checkpoint.index} of ${plan.checkpoints.length} of a plan, unattended. You can only read and search files: you cannot run anything and must not try to. Nobody can answer questions.`,
    "",
    `Plan: ${plan.title}`,
    `Goal: ${plan.goal}`,
  ]
  if (plan.rules.length > 0) lines.push("", "Rules the work had to follow:", ...plan.rules.map((rule) => `- ${rule}`))
  lines.push("", `Checkpoint: ${checkpoint.index}. ${checkpoint.title}`, "What was to be done:", ...checkpoint.todos.map((todo) => `- ${todo}`))
  lines.push("", `Review scope: ${verify.check}`, `It passes when: ${verify.expected}`)
  if (verify.note) lines.push(`Not verified by running anything (so judge it by reading): ${verify.note}`)
  if (summary.trim()) lines.push("", "What the implementer said it did (do not take it on trust; read the files):", summary.trim())
  lines.push(
    "",
    "Read the relevant files, then judge only against the scope and the condition above. Name what is wrong in concrete terms (file and line) so it can be fixed; say what you checked when it is right.",
    "End your reply with exactly one last line: `VERDICT: PASS` or `VERDICT: FAIL`.",
  )
  return lines.join("\n")
}

/** The verdict on the last non-empty line, and the reasoning before it; undefined when the reply does not end with one. */
export function parseVerdict(reply: string): { verdict: "pass" | "fail"; reasons: string } | undefined {
  const lines = reply.trimEnd().split("\n")
  const last = lines.at(-1)?.trim().replace(/^[`*_\s]+|[`*_.\s]+$/g, "") ?? ""
  const found = /^verdict\s*:\s*(pass|fail)$/i.exec(last)
  if (!found) return undefined
  return { verdict: found[1]!.toLowerCase() as "pass" | "fail", reasons: lines.slice(0, -1).join("\n").trim() }
}
