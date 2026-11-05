# File Audit：近期檔案窗口與變更通知

## 指令與設定範圍

無 config 檔、環境變數、模型工具或持久化活動日誌；不修改全域 settings/auth。

- `/file-audit`／`status`：顯示成功 read/write/edit/note 的近期活動，不讀檔案內容。
- `/file-audit clear`：清空觀察，保留目前限制。
- `/file-audit limits --window 4 --max-files 50`：只修改本 session；預設 4 runs／50 個不同檔案，可設 1–30／1–500，不接受 0 或無限。縮限立即淘汰，非法參數不部分套用。

`/file-audit check` 與 provenance 檢查已移除；本專案沒有檔案雜湊基準，也沒有這類驗證器。

run 指 before_agent_start（user/custom 均計入），不是每次工具呼叫。容量在納入時生效、同檔更新真正最後存取順序。note 路徑來自成功結構化結果，不猜檔名、不保存正文，與後續 read/edit 同檔共用名額。只觀察載入／重設後活動，不回掃 session history；start/reload/resume 恢復預設，tree 清空觀察但保留 limits。

## 變更通知

收到 user input 時，比對窗口內檔案與上一次成功存取當下的狀態；有差異就送一則只列相對路徑與 modified／deleted 的 `file-audit-changes` custom message（不含內容、不是 system prompt、同一變更只報一次、不跨 session）。外部程式與 agent 自己用 shell 的改動無法區分，只代表「觀察到差異」，不推論作者或時間。偵測失敗時不發通知、也不阻擋 prompt。顯示最多 10 筆，路徑清除控制與 bidi 字元。

cwd 在 git 工作樹內時，同一則訊息另加一行簡短提醒：分支、HEAD 或工作樹（`git status` 輸出）相對上一次回覆結束時有變。只含分支名、7 碼 HEAD 與「working tree changed」，不含路徑、diff 或內容，細節請 agent 自己用 `git status`／`git diff` 查。不跨 session；沒有 git、不在 repo 或逾時（2 秒）時不提醒。

## 載入／停用與安全

根 package 的 `modules/file-audit/src/index.ts` 為入口。透過 Pi package extensions filters 排除此入口並 reload 即停用；單純 `--tools`／`--no-tools` 不控制 slash command。不要因此修改已選工具、trust 或個人設定。TUI 手動命令才顯示狀態；RPC／JSON／print 不輸出或啟動模型。沒有 watcher、排程、背景模型或 OS sandbox。
