---
description: Scout gathers context, planner creates implementation plan (no implementation)
---
Use the subagent tool with the chain parameter to execute this workflow:

1. First, use the "scout" agent to find all code relevant to: $@
2. Then, use the "planner" agent to create an implementation plan for "$@" using the context from the previous step (use {previous} placeholder)

Execute this as a chain, passing output between steps via {previous}. Do NOT implement - just return the plan. `subagent` creates sessions only. Send later instructions with `subagent_message({ subagentSessionId: "<complete returned ID>", message: "<new instructions>" })`; the system chooses live control or safely ready asynchronous resume, not the parent's old status snapshot. Query is live-only and read-only; resume acceptance is not completion, so wait for task_result.

Each step is a separate isolated context with no parent conversation: pass concrete file paths, constraints and the expected output (a one-line conclusion first, details written to a file with only its path returned).
