# Goal

為工作階段建立「驗收目標」，由模型持續推動直到提交驗收結果或回報阻塞。Goal 與 plan 獨立：完成 plan 不代表完成 goal。

## 指令 `/goal`

| 用法 | 說明 |
| --- | --- |
| `/goal <目標>` | 建立並啟動目標（目標文字原樣使用，上限 4,000 字元） |
| `/goal -- <目標>` | 同上；用於目標文字與 `status`、`pause` 等子指令同名時 |
| `/goal` | 無目標且有 UI 時開啟輸入框；否則顯示狀態 |
| `/goal status` | 顯示目前目標、診斷與執行階段 |
| `/goal pause` | 暫停並要求取消目前執行（不會還原已產生的變更） |
| `/goal resume` | 恢復暫停或阻塞的目標，產生新的 runId，計數歸零 |
| `/goal clear` | 清除目標（不會還原已產生的變更） |

啟動／取代／恢復需要：Agent 閒置、無待處理訊息、無進行中的 goal 執行，且 `goal` 工具已被選取（本模組不會啟用被排除的工具）。取代未完成的目標在 UI 下需確認；無 UI 時須先 `/goal clear`。

## 工具 `goal`（僅模型可用）

| action | 參數 | 說明 |
| --- | --- | --- |
| `get` | — | 讀取目前目標與診斷 |
| `complete` | `goalId`、`runId`、`summary`、`verification: [{criterion, evidence}]` | 提交完成與驗收證據（`verification` 1–32 項） |
| `blocked` | `goalId`、`runId`、`reason`、`suggestedAction` | 因缺少使用者資訊、權限或外部依賴而無法繼續 |

`complete`／`blocked` 必須帶目前執行的 `goalId`／`runId`；仍有工具執行中時會被拒絕。建立、取代、暫停、恢復與清除只能由使用者操作。完成報告為模型提供的證據，並非獨立審核。

工具的 TUI renderer 顯示 action、目標狀態／原文摘要、阻塞原因及建議下一步；展開可看 ID、cwd、時間與驗收證據。完成證據明示由模型回報、非獨立審核。只改顯示，模型可見 JSON、工具 lifecycle 與持久化格式保持不變。

## 自動推進與限制

- 每次 Agent 回合結束但目標仍為 `active` 時，自動注入提醒並續跑；每個 run 最多 20 次自動續跑。
- 連續 3 次自動回應沒有任何輸出或工具活動，即暫停。
- Agent 出錯、被中止、`goal` 工具被取消選取、工作階段還原或分支切換時，目標轉為 `paused`，需 `/goal resume`。
- 目標僅適用於建立時的工作目錄；在其他工作目錄還原會暫停並要求先 `/goal clear`。
- 子代理（`PI_SUBAGENTS_GUARD`）與排程子行程（`PI_SCHEDULER_CHILD`）內不註冊指令與工具。

## 狀態

- 目標狀態：`active`、`paused`、`blocked`、`complete`。
- 以工作階段 custom entry（`pi-better-goal-state`）保存快照（上限 64 KiB），隨工作階段分支還原；無獨立設定檔或設定鍵。
- TUI 狀態列顯示 `Goal: <目標摘要> [狀態] · Auto n/20`。
- 儲存失敗時停用 goal 執行，須修復儲存並重新開啟工作階段。
