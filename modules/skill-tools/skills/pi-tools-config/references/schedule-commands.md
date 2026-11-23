# Schedule Commands：排程與 scope

## 指令與工具

- `schedule_prompt`（排程 prompt／agent session）、`schedule_shell`（到點新增一個 Shell 背景 job）與 `schedule_monitor`（到點啟動 Monitor）為 deferred 工具（namespace `schedule`，先用 `tool_search` 載入）；兩者各自只管理自己種類的 job，共用同一儲存。Action：add／list／status／update／enable／disable／remove／cleanup／run_now。
- `/schedule-commands` 開啟底部清單（Enter 詳細、`a` 新增 prompt、`m` 新增 shell、`t` 啟用／停用、`r` 立即執行、`x` 刪除、`c` 清理）；`/settings:schedule-commands` 編輯專案層設定。
- 這是 session 內排程，不是 OS scheduler；Pi 關閉時不觸發，錯過的執行依 missed 政策（skip／run-once／run-all）在下次載入時處理。請勿使用已移除的 `/schedule`、`/schedule-prompt` 或 schedule_* 舊工具。

## Config 與作用範圍

- 工作資料：`<cwd>/.pi/schedule-commands.json`，由工具／面板管理；包含 prompts／commands，視為可執行設定，不分享真實機密。舊的 `schedule-prompts*.json` 不再讀取。
- 使用者層預設：`<agentDir>/schedule-commands-settings.json`，手動維護。
- 專案覆蓋：`<cwd>/.pi/schedule-commands-settings.json`，由 `/settings:schedule-commands` 存檔時寫入；只在受信任專案採用。設定錯誤時排程不啟動並通知，不退回預設。

Settings 最小範例：

```json
{ "panelVisible": true, "defaultJobScope": "session", "defaultMissed": "skip" }
```

`defaultJobScope` 為 session（預設，僅建立者觸發）或 workdir（同 cwd 每個開啟的 Pi 都可能觸發）；改預設只影響新 job。設定在 session 開始時讀取，修改後 `/reload`。

## 建立工作

```json
{ "action": "add", "name": "review-reminder", "schedule": "+10m", "prompt": "提醒我檢查變更" }
```

- once 用 `+10m` 或明確時區 ISO；interval 用 `30s`／`5m`／`1h`／`2d`；cron 為 5 或 6 欄（6 欄首欄是秒），可帶 `timezone`。`type` 省略時由寫法推斷。
- `endAt` 是帶秒與時區的排他截止時間，只阻止新觸發；已開始工作不因此停止。Update 的 null 可移除截止。
- 不指定 model 時 prompt 注入目前 session；指定 model 時另開 in-process agent session，可能有模型費用。`notify` 只控制此子 session 結果是否喚醒 parent。
- shell job 用 `schedule_shell` 的 command，可指定 shell／timeoutMs（與 `shell` 工具相同的總時限）；無需確認、不支援 cwd。到點時新增一個 Shell 背景 job 並通知 agent「已啟動」，排程 run 隨即結束；完成時由 Shell 通知 agent。shell 的 `run-all` 補跑需設定 `allowShellRunAll`。
- 這不是 sandbox；指令無人值守執行。
- `schedule_monitor` 的 `start` 即 `monitor_start` 參數，來源只限 command／file／system，`wakeAgent` 預設 false；command 來源需 `schedule_shell` 與對應 shell 工具都啟用。同一 job 上次的監看未結束時略過本次（Monitor 同時上限 4）。
- 由排程送入的回合內只能 list／status／remove／disable。

先 list 檢查 scope、時間與是否過期；新增／啟用 job 會建立未來副作用，不把「只查設定」當成新增排程授權。
