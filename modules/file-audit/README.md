# File Audit

原生 Pi 1.5.0 extension。追蹤本 session 成功的 `read`／`write`／`edit`／`note`，顯示有界限的近期檔案活動，並在 user input 時通知檔案被外部改動；它不是驗證器，本專案沒有檔案雜湊基準，也沒有 provenance 檢查（`/file-audit check` 已移除）。

## 載入與拆裝

根 manifest 入口為 `./modules/file-audit/src/index.ts`。亦可單獨試用：

```powershell
pi --no-extensions -e ./modules/file-audit/src/index.ts
```

以既有 package extension filters 排除 `modules/file-audit/src/index.ts` 即可停用；工具 allowlist 不會停用 slash commands。本模組不註冊模型工具、不啟用其他工具、不修改其輸入／結果／system prompt（唯一的模型 context 輸出是下述「變更通知」）；無額外 runtime dependency，不 runtime import File Tools 或 Note Tools。沒有額外安裝、全域設定、模型驗證、watcher、背景工作或持久化活動日誌。

## 指令

| 指令 | 行為 |
| --- | --- |
| `/file-audit`、`/file-audit status` | 顯示窗口、容量、觀察起點、近期檔案及淘汰／略過次數，不讀候選內容 |
| `/file-audit clear` | 清空紀錄／統計，保留目前 limits |
| `/file-audit limits --window 4 --max-files 50` | 只調整本 session 限制；可省略其中一個值，縮限立即淘汰，非法參數不部分套用 |

只在 TUI 執行手動命令；RPC／JSON／print 不寫 stdout、不要求對話。事件追蹤不依賴 UI。手動命令的顯示使用宿主通知，不新增 widget，不保存報告；模型 context 只有「變更通知」。路徑清除終端控制字元與 bidi 控制碼，最多 10 筆明細、每條路徑 200 字元、總輸出 8 KiB，未顯示數明列。`check` 不再是有效動作，會得到用法錯誤。

## 窗口及成功證據

- 預設 4 runs／50 個不同檔案；可設 1–30 runs／1–500 files，0 不代表無限。run 為 `before_agent_start`（user/custom 均計入），不是每次模型／工具往返或真人輪數。
- 容量在每次納入時生效；相同檔案重新存取會更新最後活動順序。舊項目真正刪除，不是只截斷顯示。每個檔案只保留最近 read／write／note 分類所需的 run，不保存完整事件陣列。
- `tool_execution_start`／`tool_execution_end` 配對；僅確實執行且成功完成才納入，包含 nested read/write/edit/note。最多 128 筆 pending，只保存 ID、工具名、路徑／cwd 與 owner/generation/run，不保留 content/oldText/newText。路徑上限 4096 UTF-8 bytes，ID 上限 1024 bytes。
- `note` 屬新增寫入。實際路徑取成功結果的 `structuredContent.relativePath`／`details.relativePath`（同時存在須一致）；不猜檔名、不解析正文、不保存 `note.content`。後續 read/edit 同檔案共用名額，窗口內新增證據仍保留。
- 相對／絕對、`~`、file URL、`@` literal 優先與 Windows shell drive 路徑遵循 File Tools 的既有語意；已存在檔案用 realpath 去重，不一律 lowercase。
- session start（含 reload/new/resume/fork）、tree navigation、shutdown 清空觀察並撤銷舊結果；start 恢復預設 limits，tree 保留目前 limits。不讀完整歷史、不跨 session 恢復。觀察起點始終顯示。
- Shell／grep/find／其他 session／其他工具不納入。部分 read 不是完整審閱；成功 edit/write 不保證 bytes 必然改變。淘汰／略過計數是事件次數，不是精確的歷史不同檔案數。

## 變更通知

收到 user input（`before_agent_start` 的 `messageType: "user"`；extension／custom 觸發的 run 不檢查）時，比對窗口內檔案與上一次成功 read／write／edit／note 結束當下的狀態。有差異就回傳一則 custom message（`customType: "file-audit-changes"`、`display: true`），不是 system prompt、不破壞 prompt cache；內容固定英文前言（標明是資料、不是指令，編輯前先重讀）加單行 JSON：`{"changed":[{"path","change":"modified"|"deleted"}],"omitted":N}`，最多 10 筆，路徑為相對 cwd、清除控制與 bidi 字元、每條 200 字元。

- 基準只存 size／mtime 與 SHA-256（≤ 8 MiB 才雜湊，背景計算且寫入時重驗 stat），不存內容；基準數量不超過 `maxFiles`。`.env`／`.env.*`、`auth.json`、`.git`、`.pi` 路徑不觀察。
- size／mtime 相同視為未變；不同時若有基準雜湊則比對內容，僅 mtime 改變（內容相同）不通知；沒有基準雜湊（過大、尚未算完、雜湊失敗）時以 metadata 差異為準，可能誤報。單次最多讀取 32 MiB 做比對，超過的檔案只用 metadata。
- 通知後基準即更新，同一變更只報一次；檔案刪除後移除基準。自己的 edit／write 在結束時已更新基準，不會誤報。Shell 或外部程式的改動會被報告：File Audit 只觀察 read／write／edit／note，不解析 shell 指令，所以 agent 自己用 shell 修改或刪除（`sed -i`、`rm` 等）的檔案，與使用者或編輯器造成的變更無法區分，同樣會報 `modified`／`deleted`；`deleted` 只代表檔案已不存在，不推論作者。通知前言明講原因未知、可能包含 agent 自己的 shell 指令。
- 只在同一 session 內有效：session start、tree、shutdown、`/file-audit clear` 清空基準，不跨 resume，不持久化。

### Git 提醒

cwd 在 git 工作樹內時，同一則 `file-audit-changes` 訊息會多一行：`Git state differs from your last reply: branch main → dev; HEAD aaaaaaa → bbbbbbb; working tree changed. Use git status or git diff for details.`，只列有變的項目。檔案沒變但 git 變了也會送出（`details.git` 有值）。刻意簡短：不含路徑、diff、commit 數或內容，細節讓 agent 自己查。

- 基準＝上一次回覆結束（`agent_settled`）或 session start 時的 HEAD、分支（detached 顯示 `(detached)`）與 `git status --porcelain=v1 -z` 輸出的 SHA-256。比對在 user input 時進行，通知後基準即更新，同一變更只報一次。agent 自己在該次執行中的 commit／切換分支已含在結束時的基準內，不會誤報。
- 工作樹只比對 `git status` 輸出：已列為修改的檔案內容再被改動時狀態不變，不會偵測到（代理碰過的檔案由檔案層通知涵蓋）。分支名清除控制與 bidi 字元、最多 100 字元。
- git 一律經 `shared/src/git` 的 `runGit`：`--no-optional-locks`（不與使用者同時進行的 git 指令搶 index 鎖）、`-c core.fsmonitor=false`（不執行 repo 設定指定的程式）、2 秒逾時、輸出上限。沒有 git、不在 repo、尚無 commit、逾時或失敗都不提醒、不阻擋 prompt。
- 不跨 session／resume；session 開始時尚無 repo（之後才 `git init`）則下一次回覆結束後才有基準。git worktree 的切換不處理（cwd 固定）。Subagent 與 Fork 子行程各自載入 File Audit，每次執行會多幾次 git 呼叫。
- 偵測失敗、取消或擁有者換代時不發通知、也不阻擋 prompt。這只是「觀察到差異」，不推論作者或時間；到下一次 user input 才檢查，同一 run 內的外部修改仍由 `edit` 的 `expectedHash` 擋下（`STALE_FILE`）。
- 檔案 handle 前後的 size／mtime 重驗只能觀察變動，不提供原子快照或 OS sandbox；同窗口其他程式寫入仍可能造成誤報，不推論作者或引入時間。

## 驗證

```powershell
npm run test:module -- file-audit
```

包括 strict typecheck、容量／窗口／排序、note 結構化路徑、成功事件、命令／輸出邊界，以及隔離 home/agentDir/cwd 的真實 Pi 1.5.0 native/File Tools/Note/nested/變更通知（外部修改與刪除只通知一次、自己的 edit 不誤報、通知留在送給模型的 context）/reload/tree/new/resume／獨立載入／不載入 probes，另驗 `check` 已不是有效動作。SDK fixture 的 TUI 通知 callback 由測試擷取，不是人工 TUI 測試。只使用離線合成 provider，`providerCalls` 指實際外部 fetch 次數，`streamCalls` 另記合成模型串流次數。根 cross／production smoke 另驗證 manifest 共存與乾淨 tarball 載入。

先前針對 `check` 的真實 PTY TUI A/B 與「讀後外部覆寫」交付關卡實驗（`tui-ab`、`tui-workflow` 及其 fixtures）已隨 `check` 一併移除；它們量測的是 check 報告的效益與 context overhead，不是變更通知。變更通知目前只由上述 SDK host 測試與單元測試覆蓋，沒有真實 PTY 層級的 context overhead 量測。
