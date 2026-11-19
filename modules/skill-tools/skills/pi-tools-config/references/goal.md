# Goal：長時間背景目標

## 指令與工具

- `/goal <事項>` 是 prompt 範本：agent 先研究、規劃、把待決問題問完，再以 deferred 工具提交計畫。工具在命名空間 `goal`，用 `tool_search "goal"` 載入：`plan_submit`、`goal_status`、`goal_cancel`、`goal_pause`、`goal_resume`、`goal_retry`、`goal_resolve`。
- 提交的計畫要經使用者在底部面板確認每一個會被執行的指令才存檔；不受信任專案、沒有互動 UI 一律拒絕。
- 進度顯示在共用的 Jobs 面板（種類 `goal`，標籤 `GL`），進行中的 goal（含暫停、blocked）置頂；`/background-jobs goal` 可篩選。Jobs 面板只顯示；`/goals` 開底部面板，可用按鍵暫停（`p`）、恢復（`r`）、重試（`t`）、取消（`x`），動作仍經 `goal_*` 工具。

## Config 與作用範圍

**沒有設定檔，也沒有設定指令。** 不要為 goal 建立或修改任何 settings 檔。

- 狀態只在 `<cwd>/.pi/goals/<ULID>/`：`plan.json`（不變）、`goal.json`（進度，唯一真相）、`plan.md`（唯讀檢視）、`owner.json`（行程鎖）、`sessions/`。這些由模組管理，視為可執行計畫，不分享機密，也不要手動編輯進度檔。
- 只在受信任專案執行；同一時間只有一個 Pi 行程跑同一個 goal，其他行程對它回 `GOAL_RUNNING_ELSEWHERE`。
- 重啟後 `queued`／`running` 的 goal 從檔案續跑；`paused` 不續跑，須 `goal_resume`。
- 暫停（`goal_pause`）會立即中止進行中的 session 或驗收指令，該次嘗試不計次數，已改的檔案留在原處；取消不保證子行程樹已停止。
- 每個 checkpoint 最多 `maxAttempts` 次嘗試；費用沒有上限、也沒有顯示。不是 sandbox。

想停用此功能，在 package 的 `extensions` filters 排除 `modules/goal/src/index.ts`，不要改使用者其他設定。
