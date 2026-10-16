# Schedule Prompt：排程與 scope

## 指令與工具

- `schedule_prompt` 為 deferred，先 `tool_search` 搜尋 `schedule`。Action：add／list／update／enable／disable／remove／cleanup。
- `/schedule-prompt` 開啟 Jobs／Settings；Jobs 可新增、切換啟用與 scope、刪除／cleanup。Shell command job 另有互動新增流程。
- 這是 session 內排程，不是 OS scheduler；Pi 關閉時不觸發、不補跑。請勿使用已移除的 `/schedule` 或 schedule_* 舊工具。

## Config 與作用範圍

- 工作資料：`<cwd>/.pi/schedule-prompts.json`，通常由工具／UI 管理；包含 prompts／commands，視為可執行設定，不分享真實機密。
- 全域預設：`<agentDir>/schedule-prompts-settings.json`，手動維護，不由此 UI 寫入。
- 專案覆蓋：`<cwd>/.pi/schedule-prompts-settings.json`，UI 寫入；只在受信任專案採用。

Settings 最小範例：

```json
{ "widgetVisible": true, "defaultJobScope": "session" }
```

`defaultJobScope` 為 session（預設，僅建立者觸發）或 workdir（同 cwd 每個開啟的 Pi 都可能觸發）；改預設只影響新 job。手改檔案後 `/reload`，不要為修 config 而刪除活躍 writer 的 lock。

## 建立工作

```json
{ "action": "add", "name": "review-reminder", "type": "once", "schedule": "+10m", "prompt": "提醒我檢查變更" }
```

- once 用 `+10m` 或明確時區 ISO；interval 用 `5m`／`1h`；cron 為含 seconds 的6欄，例如 `0 */5 * * * *`。
- `endAt` 是帶秒與時區的排他截止時間，只阻止新觸發；已開始工作不因此停止。Update 的 null 可移除截止，不會自動重新啟用 disabled job。
- 不指定 model 時 prompt 注入目前 session；指定 model 時另開 in-process agent session，可能有模型費用。`notify` 只控制此子 session 結果是否喚醒 parent；extensions／skills 也只適用此模式。
- command job 以 command 取代 prompt（二擇一），可指定 shell／cwd／timeoutMs；確切命令需互動確認。其 timeoutMs 是**輸出停滯期限**（預設300000），不是 Shell Tools 的總時限。
- 專案外 cwd 需本行程的明確確認，reload 不保留此核准。Command 輸出僅顯示，不送模型；仍不是 sandbox。

先 list 檢查 scope、時間與是否過期；新增／啟用 job 會建立未來副作用，不把「只查設定」當成新增排程授權。
