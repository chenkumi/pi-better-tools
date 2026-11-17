---
description: Research the task, settle the open questions with you, then submit a plan that runs step by step in the background as a goal
argument-hint: "<what to get done>"
---
The user wants this done as a goal, a plan that the goal runner carries out checkpoint by checkpoint in the background, without anybody watching:

$@

Work in three phases. Do not change any file of the project in any of them: research and planning only read.

## 1. Research

Find out what the plan depends on before you write it.

1. Name what you do not know yet and what would change the plan: what the code does now, versions and dependencies, limits of the environment, how a problem is reproduced. Skip checks that have nothing to do with this task.
2. Get evidence: read the code, the settings, the documents of the version in use, or run a read-only probe (a test, a build, a query). Note where each fact came from (file, version, command) and tell what you saw from what you infer. A bug is not "reproduced" until you saw it; say which of these it is: not tried, steady, intermittent, not reproduced.
3. Say what you could not confirm, and why. Do not treat a missing fact as settled.

## 2. Plan

1. Read the project's own instructions (AGENTS.md, CLAUDE.md, README) and the code the work touches. The plan is the only thing the people carrying it out will have: they start with no memory of this conversation.
2. Decide the size. A small task is one checkpoint. A larger one is several, each with a result that can be judged on its own and an order that follows what depends on what (`dependsOn`: numbers of earlier checkpoints). Each todo names what to change, the action and the result you can see.
3. Give every checkpoint one way to check it (`verify`):
   - Tier 1, an automatic check: one `command` that the goal runner runs in the project folder and passes with exit code 0 (a test, a build, a script that asserts). Prefer the project's existing checks; a new test must check real behavior. A bug fix keeps the original trigger and the expected behavior as a regression check.
   - Tier 2, hands-on: `check` has the steps and a person does them; use it only when nothing can be run.
   - Tier 3, a review by reading: `check` is the scope to read, and `note` says what was not verified by running it. Use it when no run is possible.
   - `expected` says exactly what counts as passing. `maxAttempts` defaults to 3.
4. `rules` are what every checkpoint must follow: conventions, which commands to use, what not to touch (out of scope). `references` are the files and documents the work relies on.

## 3. Ask, then submit

The plan has no place for open questions: everything undecided is settled with the user first, here in the conversation, then written to `decisions` (question, decision, reason).

- Ask only what changes the scope, the direction or how it is checked, and what you could not find out yourself. Ask them together. Give 2 or 3 options for each, one of them recommended with the reason, and say what each option changes. Number them OQ1, OQ2, ... so the user can answer in a line.
- A question that does not block may become an assumption you state. One that blocks is answered before the affected part is planned.
- When the user has answered, show the plan in short form (title, goal, each checkpoint and how it is checked) so they can correct it. When nothing is left to ask and the plan is settled, submit it.

To submit: the tool `plan_submit` is not loaded yet. Call `tool_search` with the query `goal` to load it, then call `plan_submit` with the plan. A problem with the plan comes back as an error: fix it and submit again. The user then confirms before anything starts. If they decline, ask what to change; do not submit the same plan again.

Do not start the work yourself. When the goal is queued, say so in a line: it runs in the background, and you are told when it ends. `goal_status` (load the goal tools the same way) shows the progress.
