# Scheduler

在 Pi 開啟期間，依時間排程執行提示（prompt）的 extension。支援一次性與 cron 排程。**不安裝任何 OS service 或 Task Scheduler**；所有 Pi 視窗都關閉時不會執行任何排程。

## 整合包入口

公開 Pi 入口為 `modules/scheduler/src/index.ts`，直接載入 TypeScript 並轉接既有 `src/extension.ts`；extension 不需要先 build，更新後 `/reload` 或重新啟動 Pi 即可。只有獨立 `pi-scheduler` CLI 保留 `dist/runner.js`，開發時由根目錄 `npm run build` 編譯。模組 `package.json` 僅保留身份與根依賴的測試／建置命令，不是獨立安裝單元；不要在此目錄執行 npm install。

## 工具（供模型呼叫）

| 工具 | 說明 |
| --- | --- |
| `schedule_create` | 建立排程。參數：`prompt`（必填，1–32000 字）、`timing`（必填）、`title`、`mode`、`sessionId`、`cwd`、`execution`、`projectTrust`。回傳排程、revision、下次時間與本機執行狀態。 |
| `schedule_update` | 以 `id`、最新 `revision` 與 `patch` 更新排程。`patch` 至少一項：`title`、`prompt`、`timing`、`execution`、`projectTrust`、`state`（`active`／`paused`）。revision 衝突即失敗；變更 timing 可重新啟用已消耗的 once 排程；不會中斷進行中的 run。 |
| `schedule_status` | 唯讀。參數：`id`、`limit`（1–50，預設 20）、`offset`、`runsLimit`（0–50，預設 10）。回傳目前時間／時區、host 狀態、排程（含 revision、下次時間）與近期 run。 |
| `schedule_cancel` | 二擇一：`id`（停止未來觸發，`cancelRunning: true` 時一併請求取消進行中的 run）或 `runId`（只請求取消該 run）。取消為非同步請求，不代表程序已停止。 |

四個工具都有專用 TUI call/result renderer：收合顯示排程 ID、revision、精確下次時間／時區與 host 警告；展開可看 prompt、cwd、執行設定與 run history。取消結果明示只提出取消請求、未確認程序停止，並提醒 Pi 須開啟、錯過不補跑。只改 UI，不改 content／details／structuredContent 或排程執行語意。

### timing

```json
{ "kind": "once", "expression": "2030-09-29T11:10:00+08:00", "timezone": "Asia/Taipei" }
{ "kind": "cron", "expression": "0 9 * * 1-5",               "timezone": "Asia/Taipei" }
```

- `once`：`expression` 為含 offset 或 `Z` 的未來 ISO 時間。
- `cron`：`expression` 為 Croner 格式。
- `timezone` 必填，須為 IANA 時區。

無效 timing、過去的一次性時間、空白 prompt、不存在或非目錄的 `cwd`、無效 profile 皆使工具呼叫失敗。prompt 與 registry 不應包含憑證。

### execution 與 projectTrust

- `execution`：`provider`＋`model`（須成對）及／或 `thinkingLevel`（`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`）。省略則沿用 Pi 預設解析。
- `projectTrust`：預設 `false`。為 `true` 時，獨立子程序加上 `--approve`；否則依 Pi 既有 trust 決定（未信任專案的本地 extension／設定可能不載入）。

## 指令

```text
/schedule                       # 同 status
/schedule status | list
/schedule show <schedule-id>
/schedule runs [schedule-id]
/schedule cancel <schedule-id>      # 僅停止未來觸發
/schedule run cancel <run-id>       # 請求取消進行中的 run
```

建立、更新、暫停／恢復只能透過上述工具，指令不接受 JSON。

## 執行模式

- **independent（預設）**：以 `pi --mode json -p --name <title 或 scheduler-<runId>>` 在排程的 `cwd` 啟動無頭子程序，prompt 經 stdin 原樣傳入。子程序不繼承目前對話，prompt 須自足。建立它的對話不必保持開啟，任何共用同一 agent 目錄且開啟中的 Pi 皆可執行。
- **session**：傳入目前 `sessionId`（或 `mode: "session"`）時，只在該 session 開啟且閒置時送入；不可變更 `cwd`。忙碌時記為 `skipped_busy`，不排隊。送入後須在 15 秒內確認 scheduler 的 user `message_start`，否則記為 `failed_preflight`，不重送。排程標記 `[[pi-scheduler:...]]` 為保留字，其他 extension 不得移除。session 工作會暫時套用 `execution` profile，並在 `agent_settled` 後還原；還原失敗記為 `restoreError`，並暫停該 session 的本機派送，直到 reload。

## 執行語意

- 多個 Pi 以 advisory lock 選出一個 independent host，其餘為 `standby`，約每秒重試。另有每 session 的 lock 避免重複派送。
- 本機工具變更立即重排計時器；外部變更由輪詢發現。
- 錯過的時間**不補跑**：已過期的一次性排程記錄一筆 `missed_no_backfill`；cron 從下一次開始。一次性排程派送前先持久化 claim，claim 與啟動之間當機可能略過而非重播（at-most-once，非 exactly-once）。
- 每個 independent host 同時最多 4 個子程序；可用 `PI_SCHEDULER_MAX_CHILDREN`（整數 1–32）調整。超出容量記為 `skipped_busy`，不累積。
- 子程序環境帶有 `PI_SCHEDULER_CHILD=1`，不啟動巢狀 scheduler host；其 scheduler 工具中 status 可用，create／update／cancel 需開啟中的 host。這是工具層政策，不是 OS sandbox。
- 正常關閉、`/reload`、session 替換時，停止本機計時器、請求取消自己擁有的工作、還原 profile 並釋放 lock。
- 取消只是請求；最終結果以 run 歷史為準。host 異常結束或關閉未能確認時，未完成工作標為 `orphaned`，該排程不再自動派送新工作，且此 barrier 不會被歷史修剪移除。排程器不會依持久化 PID 強制終止程序，也無法回復已發生的副作用。子程序結束後 1500 ms 管線仍未關閉時，記為擁有者不明的 `orphaned`。
- `succeeded` 需最終 assistant 回應為 `stop`／`length`，independent 另需 exit code 0；不代表業務結果正確。

### Run 狀態

`planned`、`queued`、`running`、`cancelling`，以及終態 `succeeded`、`failed`、`cancelled`、`skipped_busy`、`failed_preflight`、`orphaned`。Run 另記錄子 Pi 版本（自訂指令為 `unknown`）、要求／實際 profile 與實際回應模型。

## 設定與環境變數

| 名稱 | 作用 |
| --- | --- |
| `PI_AGENT_DIR`、`PI_CODING_AGENT_DIR` | agent 目錄；`PI_AGENT_DIR` 優先，皆未設為 `~/.pi/agent`。子程序兩者皆設為同一目錄。 |
| `PI_SCHEDULER_MAX_CHILDREN` | 同時子程序上限，1–32，預設 4。 |
| `PI_SCHEDULER_CHILD` | 由 scheduler 對子程序設為 `1`；為 `1` 時不啟動 host。 |
| `PI_COMMAND` | 覆寫啟動子 Pi 的指令。未設時，Windows 優先使用 `%APPDATA%\npm` 下已安裝的 Pi CLI，否則用 `pi`。 |

Pi `~/.pi/agent/settings.json` 可選設定：

```json
{ "pi-scheduler": { "debugLog": true } }
```

只有布林 `true` 啟用；缺少、`false`、字串或無法讀取皆視為停用，每次失敗都重新讀取，不需 reload。固定使用 `~/.pi` 下的全域檔，不受 agent 目錄覆寫或專案設定影響。

## 儲存位置

位於 `<agent 目錄>/pi-scheduler/`：

- `registry.json`：排程（schema version 1，含 revision）
- `runs.jsonl`：run 歷史，保留最近 500 筆，另加不可修剪的進行中／orphaned run
- `logs/`：每個 run 的 stdout／stderr，每串流最多保留 64 KiB（附截斷標記）；超過 2 MiB 的 JSON 行視為無法驗證而失敗。歷史不再引用的標準 ULID（含舊版 UUID）檔名記錄會在歷史寫入後清除；進行中／orphaned、symlink 與無法辨識的檔名保留。清除失敗顯示於 `runtime.independent.retention.logCleanupError` 並於下次重試
- `registry.lock`：lock

格式錯誤的 registry 不會被靜默覆寫，手動修復前請先備份。

### 工具失敗除錯記錄

啟用 `debugLog` 後，`schedule_create`／`update`／`status`／`cancel` 執行中拋出的錯誤（含中止）會在 `~/.pi/logs/pi-scheduler/` 寫入 `<UTC 時間戳>-<ULID>.log`（JSON）：時間、工具名、tool-call ID、PID，以及受長度限制的錯誤名稱／訊息／stack。不記錄參數、prompt、設定或環境變數，但錯誤訊息仍可能含敏感資訊。成功呼叫、人工指令與非同步排程結果不寫入；記錄無自動清理。

## 獨立 CLI（進階）

`pi-scheduler` 可手動執行，與 extension 共用 host lock，不能與持有 lock 的 app 同時執行，也不會安裝服務：

```sh
pi-scheduler daemon  [--agent-dir <path>]
pi-scheduler status  [--agent-dir <path>]     # 本機快照 JSON，非連到其他程序
pi-scheduler run-once --schedule <id> [--agent-dir <path>]
```
