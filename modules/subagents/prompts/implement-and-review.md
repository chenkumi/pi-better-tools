---
description: Worker implements, reviewer reviews, worker applies feedback
---
Use the subagent tool with the chain parameter to execute this workflow:

1. First, use the "worker" agent to implement: $@
2. Then, use the "reviewer" agent to review the implementation from the previous step (use {previous} placeholder)
3. Finally, use the "worker" agent to apply the feedback from the review (use {previous} placeholder)

Execute this as a chain, passing output between steps via {previous}. Each step is a separate isolated context with no parent conversation, so give every task concrete file paths, constraints and handoff details, and ask for a one-line conclusion first with long details written to a file (return only the path).

Every initial task automatically saves a managed native session; do not pass a resumable parameter. Each chain step receives its own session ID, not one shared history. After a child reports a question and exits normally, obtain the decision in the parent and continue that child with only `{ resume: "<complete returned subagentSessionId>", task: "<concrete new decision/work>" }`; do not repost logs or pass configuration overrides.
