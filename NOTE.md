## Agent Rules
1. 在用戶指示下透過 `orca` CLI 將任務發送給其他 Agents 執行（如 ClaudeCode/Pi/Codex）。使用前先執行 `orca skills get orca-cli` 載入指引；CLI 解析規則與指令細節以該 skill 為準，此處不重複。
2. 只能發送給「同一 worktree」的 Agent：先 `orca worktree current --json` 取得自己的 worktree，再 `orca terminal list --worktree <id> --json` 找目標。同 worktree 不存在目標 Agent 時，請自行接手處理；僅當任務是獨立工作且使用者同意，才用 `orca worktree create --no-parent --agent <id> --prompt "..." --json` 另開（不指定 `--base-branch`）。
3. 預設為完整交接（full handoff）：送出且 receipt 為 `accepted: true` 後即停止，不輪詢、不等待對方完成；對方完成後會依規則 5 的回報指令主動把結果送回，屆時再處理。只有使用者明確要求監督、等待結果或追蹤進度時，才改用 `orchestration` skill。
4. 送出前先 `orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json`，確認 `satisfied: true` 才送，否則 prompt 會遺失；逾時則放大 timeout 重試一次，仍失敗就回報未送出。送出後不因無回應而重送（需確認時用 `--wait-submit`）。同一 Agent 只用一個 handle；handle 失效（`terminal_handle_stale`）時重新 list，只送新的，不可雙送。
5. 每次發送任務，都必須在任務內容末尾附上「完成回報」指令，要求目標 Agent 在任務結束後執行一段 CLI，把結果回報給發送方：
   - 先用 `orca terminal list --json` 查出自己的 handle（`<我的handle>`）。
   - 附加段落固定為：
     ```
     ---
     【完成回報】任務結束後（無論成功或失敗），最後一個動作請執行：
     orca terminal send --terminal <我的handle> --text "[From <你的名稱/handle>] 任務完成：<一至三句結果摘要；失敗請寫原因>" --enter --json
     回報只送一次；不要對這則回報再回覆；摘要請用單行、避免雙引號，且不得包含 .env 內容、連線字串等機密。
     ```
   - `<我的handle>` 必須在送出前替換成實際值；細節（檔案、diff）寫在 worktree 內，回報只放路徑與結論。
   - 回報訊息本身不再附「完成回報」段落，以免互相觸發迴圈。
   - 需要結構化往返（ask/reply、多任務）時，改用 `orchestration` skill。
6. 發送任務開頭請註明發送方（你自己的身份），末尾附規則 5 的【完成回報】段落：
```
[From <Agent 名稱 / terminal handle>]

<Task Content>

<規則 5 的【完成回報】段落>
```



## Action Rules
- **Terminology Consistency**: Use existing project terminology. Do not guess or invent names.
- **Clarify the Problem First**: Start from the original requirements and think from first principles. Do not blindly follow past experience or existing solutions, and do not assume the user has fully clarified their goals.
- **Goals and Solutions**: If the goal is unclear, stop and seek clarification. If the goal is clear but the proposed solution is suboptimal, proactively suggest a simpler, more cost-effective approach with better readability and maintainability.
- **Simplicity First**: Solve problems with the least amount of code possible. Answer only what is actually asked, and ensure any necessary additional information directly serves the original question.
- **Minimal Changes**: Modify only what is necessary and clean up only issues introduced by your own changes. Do not refactor working code or modify adjacent code, comments, or formatting without permission.
- **Limited Testing**: Restrict testing to the parts modified by the current task. Do not unnecessarily expand test coverage or add test cases. Do not run the full project test suite without permission.
- **Clean UI Design**: Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.