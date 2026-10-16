monitor
- file
- subagent
- shell
- plan

如果有派遣背景subagent或shell進行任務, 如果當下沒有需要立即執行的任務，需要等後所有任務完成再回報用戶結論

sheduler 是否可以執行shell command
與blackhole是配


長時間卡住
grep name
fork
shell / subagent加上可選的最常時間限制
超過一定時間自動進入背景並開啟monitor
自動提醒


## Action Rules
- **Terminology Consistency**: Use existing project terminology. Do not guess or invent names.
- **Clarify the Problem First**: Start from the original requirements and think from first principles. Do not blindly follow past experience or existing solutions, and do not assume the user has fully clarified their goals.
- **Goals and Solutions**: If the goal is unclear, stop and seek clarification. If the goal is clear but the proposed solution is suboptimal, proactively suggest a simpler, more cost-effective approach with better readability and maintainability.
- **Simplicity First**: Solve problems with the least amount of code possible. Answer only what is actually asked, and ensure any necessary additional information directly serves the original question.
- **Minimal Changes**: Modify only what is necessary and clean up only issues introduced by your own changes. Do not refactor working code or modify adjacent code, comments, or formatting without permission.
- **Limited Testing**: Restrict testing to the parts modified by the current task. Do not unnecessarily expand test coverage or add test cases. Do not run the full project test suite without permission.
