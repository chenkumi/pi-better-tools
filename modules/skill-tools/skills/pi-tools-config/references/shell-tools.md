# Shell Tools：總逾時、背景工作與 Bash 設定

## 指令與工具

- `bash`／`powershell`：`{ command, timeoutMs?, background? }`；PowerShell 後端僅原生 Windows。
- `shell_job_status { jobId? }`、`shell_job_cancel { jobId }` 需另行選取，只有 shell 的 loadout 不代表管理工具可用。
- 共用 `/background-jobs shell`、`more`／`all`、`collapse` 顯示或收合 TUI 工作面板。
- 無獨立的 `/shell-tools` 設定命令。主代理的 `bash`／`powershell` 與 `shell_job_status`／`shell_job_cancel` 均 `defaultActive: true`，載入即預設啟用；仍受 Pi `--tools` allowlist／`--exclude-tools`／`--no-tools` 控制。Managed child 的前景 Shell 仍 `defaultActive: false`。

## Config 與作用範圍

Bash 執行讀取 Pi 有效設定（全域與受信任專案 settings）：

```json
{
  "shellPath": "/bin/bash",
  "shellCommandPrefix": "",
  "pi-shell-tools": { "autoBackgroundMs": 180000 }
}
```

- `shellPath` 請換成目標平台的真實 Bash 路徑；Windows 可用 Git Bash。
- `shellCommandPrefix` 只適用 Bash，不套用 PowerShell；不要放入密碼或有破壞性的前綴。
- `pi-shell-tools.autoBackgroundMs` 預設 180000，正整數毫秒；0 停用前景自動轉背景。它不是指令總逾時。
- 改持久設定後 `/reload`，SDK 可 reload settings／使用有效覆寫；重載前先處理仍必要的背景工作。

除錯開關是另一個來源：固定家目錄 `~/.pi/agent/settings.json` 的 `pi-shell-tools.debugLog`，預設 false；不跟隨 `PI_CODING_AGENT_DIR`，也不採專案值，每次失敗重讀。True 會在 `~/.pi/logs/pi-shell-tools/` 寫含原始命令／輸出的診斷，需自行清理。

## 使用差異與驗證

`timeoutMs` 是自啟動起算的**總時限**，輸出不重置；省略時沒有該期限。未設期限的前景工作預設滿 180 秒交接為同一個背景 process，不重跑；交接後要用 owned cancel 工具停止。未設期限的背景 job 可 best-effort 自動建立 display-only Monitor，不會啟用未選工具。

Managed Subagent child 的同名 shell 只支援前景，完全不要傳 `background` 欄位。長 script 應定期輸出英文進度。驗證先用無副作用的短指令，不以取消要求宣稱整棵程序樹已停止。
