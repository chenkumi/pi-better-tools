# Monitor：command、WebSocket 與背景工作監看

## 指令與工具

- `monitor_start { source, durationMs?, wakeAgent?, stopAfterEvents?, label? }`。
- `monitor_status { monitorId? }` 唯讀查看；省略列出保留項目。
- `monitor_stop { monitorId }` 要求停止來源；不等於已觀察到 close 或子程序樹清理。
- 沒有專屬 slash config 命令。三工具預設啟用，仍受 Pi allowlist／exclude／no-tools 控制；explicit managed Subagent child 不提供。

## Config 與作用範圍

**沒有持久模組設定檔；以下都是本次工具呼叫參數。**

```json
{
  "source": { "kind": "shell_job", "jobId": "<owned job id>", "intervalMs": 60000 },
  "durationMs": 300000,
  "wakeAgent": false
}
```

來源只能擇一：

- command：`{ kind: "command", tool: "bash"|"powershell", command }`，沿用有效 Shell 設定；PowerShell 僅原生 Windows，不是 PTY。此路徑的授權 hook 應檢查 monitor_start，不假定只封鎖 bash 就能封鎖它。
- websocket：`{ kind: "websocket", url, allowPrivateNetwork?, allowInsecure? }`。預設公開 wss；私網與不加密 ws 分別須本次明確 opt-in，不自動降低 TLS 驗證。不要放入帳密或敏感 query。
- shell_job／subagent_job／fork_job：owned jobId 與 intervalMs（30000–300000，預設60000）；唯讀，不 query 模型、不讀 log、不取消 job。fork_job 由 Fork 模組在 session_start publish／session_shutdown revoke，只回有界狀態（status／delivery／elapsedMs／cleanup／transcript state／blocked），不含任務全文或結果；Fork 結果仍只經 fork-result 通知。

共通 durationMs 預設300000，範圍1000–1800000，包含啟動；wakeAgent 預設true，false 只顯示資料而不要求模型回合。每 owner 最多4 active。Shell 的無期限背景 job 可能自動占一個名額。

監看只存在目前 session/runtime，不跨 reload 恢復。先 status 診斷，不因沒有資料就推論來源已停止；開始監看 command／端點可能有副作用，依使用者授權。輸出不是全面機密 scrubber，不能將敏感 stdout 安全化當成保證。
