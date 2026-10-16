# PTY Terminal：互動終端、WSL／SSH targets

## 指令與工具

`pty_spawn`、`pty_write`、`pty_read`、`pty_resize`、`pty_wait_exit`、`pty_kill`、`pty_list` 全為 deferred，先以 `tool_search` 搜尋 `pty`。沒有專屬 slash 設定命令。Spawn 選 target，後續只用 sessionId；一次性指令用 shell、持續輸入的互動程式／TUI 才用 PTY。

## Config 與作用範圍

設定置於 Pi 全域或受信任專案 `.pi/settings.json`，namespace 為 `pi-pty-terminal`，修改後 `/reload`：

```json
{
  "pi-pty-terminal": {
    "targets": {
      "linux": { "transport": "wsl", "distribution": "Ubuntu", "cwd": "/home/user/project" },
      "remote": { "transport": "ssh", "host": "dev-host", "cwd": "/home/user/project" }
    },
    "env": { "deny": ["AWS_*", "TOKEN_*"] }
  }
}
```

- `local` 為保留內建 target，省略 target 即 local，不能覆寫。
- WSL target 僅 Windows host；SSH host 為 SSH config alias，可包含 user@host。Port／key／ProxyJump 在使用者 SSH config 設定，不放密碼或自由 SSH options。
- 遠端 cwd 必須為絕對 POSIX 路徑；未知 target／錯誤設定不退回 local，不自動映射 Windows 路徑。
- 只有指定 env 過濾才改變繼承環境。`allow` 存在時只保留匹配變數，`deny` 再移除；模式只支援結尾 `*` 前綴匹配，空 allow 代表不繼承。Windows 應保留 PATH／SystemRoot 等必要變數。
- 過濾器不是一般 glob；請使用確切名稱或結尾星號前綴，不以 `*_TOKEN` 這類模式猜測後綴匹配。

## 安裝與驗證

在 package 根目錄 `npm run pty:install` 明確建立 node-pty native setup。SSH 先由使用者驗證 alias／key／known_hosts；不關閉 host-key 檢查或自動 Git 同步。以 `pty_spawn { target: "remote", command: "sh" }` 建立後，read 輸出與 wait_exit 才能確認 transport 狀態。

本機 kill 不保證遠端子程序樹停止；PTY 不提供每個 shell 指令的結構化 exit code。設定 target 不會移動其他 file／shell 工具的 cwd。
