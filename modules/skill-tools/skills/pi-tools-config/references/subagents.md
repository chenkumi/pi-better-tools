# Subagents 與 Spinoff：委派、自訂 agent 與設定

## 指令與工具

- `subagent` 建立 single（agent/task）、parallel（tasks）或 chain（chain）；選用 `background: true`。
- `spinoff { task, title? }` 建立繼承本對話的獨立 Pi 工作（見下方 Spinoff 一節）。
- `agent_message`：Subagent 以完整 `subagentSessionId` 送 control／續接，或 `mode: "query"` 唯讀詢問；Spinoff 以 `jobId` 定址，`mode` 為 `follow_up`（預設）或 `steer`。兩者擇一，不可同時給。
- `agent_status` 查 owned job（不帶 `jobId` 時同時列出 `jobs` 與 `spinoffs`），`agent_cancel` 要求取消；`jobId` 屬於本 session 的 Spinoff 時交給 Spinoff，否則視為 Subagent job。不要把接受／取消 receipt 當工作完成。
- 隨包 prompt commands：`/implement`、`/scout-and-plan`、`/implement-and-review`。
- 共用 `/background-jobs`、`more`／`all`、`subagents`／`shell` 篩選、`collapse` 控制 TUI 面板，不是新增 job 或持久化設定。

## 自訂 agents 與作用範圍

- 使用者：`<agentDir>/agents/*.md`，預設 `~/.pi/agent/agents/`，支援 `PI_CODING_AGENT_DIR`。
- 專案：從 cwd 向上最近的 `.pi/agents/`；同名優先序為專案 > 使用者 > bundled。
- 工具參數 `agentScope` 預設 `user`；需要專案 agent 時用 `project` 或 `both`，仍遵守 trust／確認。
- 子代理只取得 agent 檔 `tools:` 列出的工具（白名單）；沒寫 `tools:` 時預設只有 `read, grep, find, ls, note`，要用 shell、寫檔、web 等須明列；SQLite 與 SQL 資料庫工具不提供給子代理。內建名稱為 `scout`、`planner`、`reviewer`、`worker`。模型以 agent 定義或 parent 繼承；呼叫的 model/provider/thinkingLevel 預設省略，只有使用者或技能明確指定時才傳。

最小 agent 檔案（本文為 system prompt）：

```markdown
---
name: config-reader
description: Inspect project configuration without changing files
tools: read, grep, find, ls
---
Inspect the requested configuration and report the exact keys and paths.
```

`model` 為選填 frontmatter；不要填不存在的模型 ID。修改 agent 後重新載入；已保存 child 的設定指紋可能不再符合，不能改 manifest／checkpoint 繞過驗證。

## Config 與套用

唯一模組設定為全域 `<agentDir>/settings.json` 的 `pi-subagents.debugLog`；不讀專案同名鍵，每次工具呼叫重讀：

```json
{ "pi-subagents": { "debugLog": false } }
```

設為 true 時 failed-task 診斷存於 `~/.pi/logs/pi-subagents/`，可能含 prompt／程式碼／輸出，沒有自動清理。Managed sessions 位於 `<agentDir>/subagent-sessions/`，不是可任意編輯的 config；未確認 writer／I/O 結束前不要刪鎖。Quit／reload 會要求取消工作；process isolation 不是 sandbox。

## Spinoff：繼承對話的獨立 Pi 工作

- `spinoff` 非同步受理，稍後於 canonical turn_end 取得對話快照；管理一律用上面的 `agent_status`／`agent_cancel`／`agent_message`（`jobId`）。
- `agent_message` 只受理 `running`／`blocked` 的 Spinoff：其他狀態直接拒絕，不排隊不重播，每 Spinoff 上限 32。receipt 的 `queued`／`not_applied`／`delivery_unknown` 都**不代表已套用**，只有 child 自己收到該文字才算 `applied`。
- 共用 `/background-jobs spinoff` 看 TUI 清單；完成的原生對話可用 Pi `/resume` 載入，執行中不要當 live attach 使用。
- **沒有專屬 JSON config 鍵。** `spinoff` 與三個 `agent_*` 工具均 `defaultActive: true`；宿主的 `--tools` allowlist、`--exclude-tools`、`--no-tools` 與手動停用仍優先。Subagent child 不註冊這些工具；Spinoff child 為延續父代快取前綴，註冊與父代相同的定義，但 `spinoff` 一律拒絕，`agent_*` 也不能定址 Spinoff。
- Spinoff 繼承 parent 有效 cwd、model／thinking、工具與資源，不提供 override；不建立 git worktree、不同步 parent 後續訊息、不合併檔案。
- Metadata／有界結果在 `<cwd>/.pi/spinoffs/<jobId>.json`，原生對話在來源 sessionDir，另有只含 Spinoff 開始後訊息的查詢 transcript `<cwd>/.pi/spinoffs/<jobId>/transcript.jsonl`（輔助檔，失敗不影響 Spinoff）；這些是執行紀錄，不是設定檔，不要手改指紋或刪除仍有 writer 的對話。
- Spinoff 可使用 Subagent，但不能再建立 Spinoff；所有 Subagent child 亦不可建立 Spinoff。這是工具契約，不是 OS sandbox。最多 4 個未完成 Spinoff，與 parent 共用 workspace；Quit／reload 會扇出取消。
