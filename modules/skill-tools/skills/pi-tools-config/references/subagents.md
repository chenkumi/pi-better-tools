# Subagents：委派、自訂 agent 與設定

## 指令與工具

- `subagent` 建立 single（agent/task）、parallel（tasks）或 chain（chain）；選用 `background: true`。
- `subagent_message` 以完整 `subagentSessionId` 送 control／續接，或 `mode: "query"` 唯讀詢問；不是以 jobId 定址。
- `subagent_status` 查 owned job，`subagent_cancel` 要求取消；不要把接受／取消 receipt 當工作完成。
- 隨包 prompt commands：`/implement`、`/scout-and-plan`、`/implement-and-review`。
- 共用 `/background-jobs`、`more`／`all`、`subagents`／`shell` 篩選、`collapse` 控制 TUI 面板，不是新增 job 或持久化設定。

## 自訂 agents 與作用範圍

- 使用者：`<agentDir>/agents/*.md`，預設 `~/.pi/agent/agents/`，支援 `PI_CODING_AGENT_DIR`。
- 專案：從 cwd 向上最近的 `.pi/agents/`；同名優先序為專案 > 使用者 > bundled。
- 工具參數 `agentScope` 預設 `user`；需要專案 agent 時用 `project` 或 `both`，仍遵守 trust／確認。
- 內建名稱為 `scout`、`planner`、`reviewer`、`worker`。模型以 agent 定義或 parent 繼承；呼叫的 model/provider/thinkingLevel 預設省略，只有使用者或技能明確指定時才傳。

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
