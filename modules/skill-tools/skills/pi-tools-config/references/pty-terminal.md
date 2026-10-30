# PTY Terminal：互動終端、WSL／SSH targets

## 指令與工具

`pty_spawn`、`pty_write`、`pty_keyin`、`pty_read`、`pty_resize`、`pty_wait_exit`、`pty_kill`、`pty_list` 全為 deferred，先以 `tool_search` 搜尋 `pty`。沒有專屬 slash 設定命令。Spawn 選 target，後續只用 sessionId；一次性指令用 shell、持續輸入的互動程式／TUI 才用 PTY。

程式要求密碼等機密時用 `pty_keyin`：使用者在遮罩輸入框直接輸入；畫面會顯示 Unicode code point 數，機密內容與長度不回給 agent，內容只寫入該 PTY、不進對話或紀錄；呼叫可帶 `confirmPrompt`：送出前會檢查 session 最後一行，像 shell 提示符（程式已逾時／出錯離開密碼提示）就拒絕開啟，或在使用者輸入後、寫入前改為不送（`reason:"prompt_gone"`）；確認程式真的在等機密時才用 `confirmPrompt:true`。送出的機密在該 session 釋放前，會在 `pty_read`／`pty_write(readAfterMs)`／`waitFor` 看到的輸出中被換成 `********` 並附提示（只認原樣字串，轉成 base64 等形式擋不住；遠端 shell history 仍可能留有紀錄，出現遮罩提示時應視為密碼可能暴露並建議更換）。無互動 UI 時不可用。

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

```text
pi-better-tools doctor
pi-better-tools pty setup
```

上述短命令只適用已安裝套件的 bin 在 PATH，且是目前 Pi 使用的那份套件；不需位於 repository。Pi-managed 安裝可能不提供 PATH 命令，應使用診斷提供的「目前 Node＋此安裝實例 setup/cli.mjs」絕對命令；無提示時先確認實際安裝路徑。命令形式與跨平台範例見 [Web 安裝說明](web-tools.md)，將末尾 `browser install` 換成 `pty setup`。不要由已搬移的 skill 位置猜套件路徑，也不要用 npx 下載另一個版本。

`doctor` 不啟動 PTY、不寫設定或安裝；`pty setup` 是明確的 native setup 操作，針對此安裝實例解析到的 node-pty，而非目前 cwd 的任意套件。安裝時若使用 `--ignore-scripts` 或禁止 native scripts，先依 consumer project 的政策核可 node-pty；本套件不把自己的 allowScripts 當成 parent project 的授權、不覆寫全域 npm 設定。沒有適用的 prebuild 時仍需本機編譯工具；禁止跨 OS／CPU 共用 node_modules。`npm run pty:install` 保留為開發者別名，不是安裝後唯一入口。

CLI 要求解析到的 node-pty 所屬最外層 consumer `package.json` 已精確核可實際版本（本版為 `allowScripts: { "node-pty@1.2.0-beta.15": true }`），不是 dependency 自己的 manifest，也不接受 wildcard 代替。只在使用者明確同意後合併該鍵，不覆寫其他設定。沒有可讀 consumer manifest 的全域／特殊安裝 layout 會拒絕；改用該安裝管理者核可的 native setup，或使用明確 consumer project，不偷偷建立 manifest。其他 `ignore-scripts` 設定仍保留，所以 setup exit 0 後仍需 doctor／實際 spawn 證據。

SSH 先由使用者驗證 alias／key／known_hosts；不關閉 host-key 檢查或自動 Git 同步。以 `pty_spawn { target: "remote", command: "sh" }` 建立後，read 輸出與 wait_exit 才能確認 transport 狀態；native setup 成功不證明 SSH／WSL 或遠端命令可用。

本機 kill 不保證遠端子程序樹停止；PTY 不提供每個 shell 指令的結構化 exit code。設定 target 不會移動其他 file／shell 工具的 cwd。

TUI 中有 PTY session 時，輸入欄上方的 Jobs 面板會與其他背景工作一起列出 `PT` 列（只顯示本 workspace 執行中的 session，不顯示輸出或指令；`/background-jobs pty` 可開清單）。Blackhole 壓縮摘要的 `[Background Jobs]` 也會列出執行中的 `PTY Session`（只有 ID 與狀態），這些 session 可能在等輸入，請先用 `pty_list`／`pty_read` 核對，不要重複 spawn。這些顯示不是設定項目，也沒有開關。
