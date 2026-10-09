---
description: Full implementation workflow - scout gathers context, planner creates plan, worker implements
---
Use the subagent tool with the chain parameter to execute this workflow:

1. First, use the "scout" agent to find all code relevant to: $@
2. Then, use the "planner" agent to create an implementation plan for "$@" using the context from the previous step (use {previous} placeholder)
3. Finally, use the "worker" agent to implement the plan from the previous step (use {previous} placeholder)

Execute this as a chain, passing output between steps via {previous}. `subagent` creates sessions only. For later instructions to an existing step, use `subagent_message({ subagentSessionId: "<complete returned ID>", message: "<new instructions>" })`; mode defaults to control and the system routes live control or safely ready asynchronous resume. Query is live-only and read-only. queued/startup/finalizing/canceling/busy messages are rejected, not queued across invocations; do not retry accepted or delivery_unknown controls.

Each step is a separate isolated context with no parent conversation: pass concrete file paths, constraints and the expected output (a one-line conclusion first, details written to a file with only its path returned).
