# Schedule Commands

原生排程模組，取代已移除的第三方 Schedule Prompt 快照。在 Pi session 開著時，依 cron／間隔／一次性時間送出 prompt、啟動獨立 agent session，或執行 shell 指令。

**不是 OS 排程或 sandbox**：Pi 關閉時不會觸發；錯過的執行在下次 session 載入時依政策處理。agent job 在行程內以 SDK 建立 session，不經 Subagents 的 argument builder 與 `--exclude-tools subagent` 保障；取消只呼叫 `session.abort()`，不代表底層 process tree 已停止。

## 工具與指令

| 項目 | 說明 |
| --- | --- |
| `schedule_prompt` | prompt job（送入目前對話）與 agent job（指定 `model`，獨立 in-process session）。`defaultActive: true`，直接宣告、不經 deferred。 |
| `schedule_shell` | shell command job（`command`／`shell`／`cwd`／`timeoutMs`）。`defaultActive: true`。 |
| `schedule_monitor` | monitor job：到點時請同一 session 的 Monitor 啟動一個監看（`start` 即 `monitor_start` 參數）。`defaultActive: true`。 |
| `/schedule-commands` | 底部面板清單：↑↓／PgUp／PgDn、Enter 詳細、`a` 新增 prompt、`m` 新增 shell、`t` 啟用／停用、`r` 立即執行、`x` 刪除、`c` 清理。動作一律經上面三個工具（依 job 種類）的 `execute`，驗證與確認不另寫一份；新增只有 prompt（`a`）與 shell（`m`），monitor job 只能用 `schedule_monitor` 建立。 |
| `/settings:schedule-commands` | 共用 settings-panel，寫入專案層設定檔，只在存檔時寫；設定於 session 開始時讀取，存檔後需 reload。 |

三個工具共用儲存，但各自只列出與變更自己種類的 job（`schedule_prompt`：prompt／agent；`schedule_shell`：shell；`schedule_monitor`：monitor），所以 `--tools`／`--exclude-tools` 可分開允許或禁止。actions：`add`、`remove`、`list`、`status`、`enable`、`disable`、`update`、`cleanup`、`run_now`。

排程寫法：`cron`（5 或 6 欄，可帶 IANA `timezone`）、`interval`（`30s`／`5m`／`1h`／`2d`）、`once`（`+10m` 或含時區的 ISO 時間）。`endAt` 為含時區的 ISO 截止時間（排他）。

## 儲存與設定

- job：`<cwd>/.pi/schedule-commands.json`（`version: 2`）。舊的 `.pi/schedule-prompts*.json` **不讀取、不遷移**，只提示一次，請用工具重建。
- 損毀的檔案改名為 `.corrupt-<時間>`，無效的 job 先備份為 `.invalid-<時間>`，不覆蓋。寫入需目錄鎖（等待上限環境變數 `PI_SCHEDULE_COMMANDS_LOCK_WAIT_MS`），不按鎖齡接管、不無鎖寫入；crash 遺留的鎖須確認沒有 writer 後手動移除。
- 設定：使用者層 `<agentDir>/schedule-commands-settings.json` 為預設，專案層 `<cwd>/.pi/schedule-commands-settings.json` 覆蓋（只在受信任專案讀取）。嚴格驗證，未知鍵或錯誤值使排程不啟動並通知，不退回預設。

| 鍵 | 預設 | 說明 |
| --- | --- | --- |
| `panelVisible` | `true` | 在 Jobs 面板顯示排程列 |
| `defaultJobScope` | `session` | 新 job 綁定 session，或 `workdir`（同目錄所有 session 可見） |
| `defaultMissed` | `skip` | `skip`／`run-once`／`run-all` |
| `defaultMaxLateMs` | `3600000`（1 小時） | 晚於此值的錯過執行不補跑；`0`–604800000 |
| `maxCatchUp` | `10` | `run-all` 的上限；1–100 |
| `allowShellRunAll` | `false` | shell job 才可使用 `run-all` |
| `maxConcurrentAgents`／`maxConcurrentCommands` | `4`／`4` | 同時執行上限；各 1–16 |
| `commandOutputTailBytes` | `8192` | 每次 run 保留於顯示標記的輸出尾端；1024–1048576（Jobs 面板的即時副本另有 128 KiB 上限，與此無關） |

## 執行語意

- 引擎只用一個計時器，指向所有 job 中最早的 `nextDue`；`nextDue` 持久化在檔案內。多個 session 以 compare-and-set 搶佔同一次執行，每次執行只會有一個 session 啟動。
- 準時（`LATE_GRACE_MS` 5 秒內）與錯過分開處理。同一時刻的順序：shell → agent → monitor → prompt；prompt 最多等前面的「已啟動」2 秒。interval 以 `createdAt` 為錨點。
- prompt job：寫入顯示用 marker 後以 `sendUserMessage(deliverAs: "followUp")` 送入對話。
- agent job：獨立 in-process session，30 分鐘上限，`notify` 時以 steer 喚醒對話；預設不載入其他 extensions。**尚未以真實模型實測**。
- shell job：須在互動 session 確認確切指令；經 Monitor 的 Shell helper 在 session 內執行，不啟動模型、不喚醒 parent，輸出只進顯示用 marker。`timeoutMs` 是輸出停滯期限，不是總時限。每次執行重新 realpath cwd；專案外目錄只在本行程核准後執行，核准不持久化。
- `schedule_shell` 啟用前提：`bash` 或 `powershell` 至少一個已啟用（檢查工具啟用，不是政策）。
- scheduled turn（由排程送入的回合）內只允許 `list`／`status`／`remove`／`disable`；`add`、`update`、`enable`、`run_now` 一律拒絕。provenance 取自對話分支中的 marker。
- 受管 child（Subagent／Fork）不註冊本模組。

## Monitor job（`schedule_monitor`）

- 機制：Monitor 在 `session_start` 經 `shared/src/background/monitor-capability.ts` 發布「排程啟動器」（`validate`／`start`／`isActive`，與既有 rendezvous 同型：owner、canonical cwd 對得上才取得，不共享 handle）；排程到點呼叫它，由 Monitor 自己驗證並決定。Monitor 沒載入、`monitor_start` 未啟用、被拒絕或沒有名額，只在顯示標記與 `state.lastError` 記錄原因，不影響其他 job。
- 允許的來源：`command`、`file`、`system`；`websocket` 與 `shell_job`／`subagent_job`／`fork_job` 拒絕（錯誤訊息列出允許來源）。Monitor 側的啟動器也同樣拒絕。
- `wakeAgent` 預設 **false**（Monitor 側補預設）；設 `true` 須使用者在確認畫面看到「WAKES THE AGENT」後同意。由 Monitor 喚醒的回合**不受** scheduled-turn 保護（沒有排程 marker），可能在該回合建立新排程；這與手動 `monitor_start` 的暴露面相同，差別是使用者不在場，所以預設關閉並在確認畫面明示。
- `command` 來源等於無人值守執行指令：`schedule_shell` 與 `start.source.tool` 對應的 `bash`／`powershell` 必須都已啟用，建立、更新、重新啟用時當場檢查，每次到點前再檢查；未啟用則報錯／跳過並記錄。確認畫面顯示確切指令。
- 互動新增、變更 `start`、重新啟用、`run_now` 都須確認；無 UI 拒絕。
- 壽命沿用 Monitor 的 `durationMs`（上限 1800000）；每次到點啟動一個新的監看，session 關閉或 reload 時一併結束，不跨重啟重播。
- Monitor 同時活躍上限為 4。同一個 job 上一次啟動的監看還在跑時，這次到點**略過**（`skipped`，顯示標記說明），不堆疊；這個記錄只在記憶體，reload 後重置。其他 job 或手動監看佔滿名額時，到點會因 Monitor 拒絕而記錄錯誤。
- 與 shell 連動：用 `schedule_shell` 與 `schedule_monitor` 排**同一時間**，引擎保證 shell 先 spawn 再啟動 monitor；兩個 job 的補跑策略各自獨立。monitor job 的 `missed` 只允許 `skip`／`run-once`，預設 `skip`。
- 輸出不進模型上下文的不變量不變：排程模組不轉送指令輸出，Monitor 回報由 Monitor 自己的規則決定。

## 與其他模組

- Jobs 面板：種類 `schedule`（標籤 `SC`，計數 `⏱ Schedule`）；執行中顯示 `running`，閒置顯示 `in 12m | every 1h`，停用的只出現在 `/schedule-commands`。每 60 秒更新相對時間。被動列不含 prompt 或指令文字。
- 執行中的 job 在 Jobs 面板展開（點列或 `/background-jobs schedule`）可看即時內容：shell job 是輸出尾端（最多 128 KiB 記憶體副本），agent job 是子 session 的對話。副本只存在記憶體、只供顯示，不寫檔、不進模型；run 結束（成功、失敗、取消或 session 結束）即釋放，關閉面板後無法回看。prompt／monitor job 沒有即時內容，展開只顯示中繼資料。
- Pi Auto Compact：壓縮摘要的 `[Background Jobs]` 列出執行中的排程 run（`Schedule Job: <id> (running)`），只有 id 與狀態。
- system prompt：結構化 section `schedule_rules`（短規則，只提已啟用的工具）。
- File Audit 的 git 提醒排除 `.pi/schedule-commands*`。

## 尚未完成

- 面板新增流程只問名稱、時間、內容，進階欄位（agent、cwd、timeout、missed）只能用工具設定。
- 未做真實 Pi／真實模型／真實 Monitor 的端對端驗證。特別是 `session_start` 內的補跑發生時，宿主的啟用工具集（`getActiveTools`）是否已定案尚未在真實 host 驗證，這影響 `schedule_shell` 與 monitor 的 shell 檢查。

## 測試

`npm run test:module -- schedule-commands`（typecheck 與單元）。測試使用 `ManualClock` 與假執行器，不依賴真實時間、固定 port 或付費模型。
