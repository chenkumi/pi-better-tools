# PTY Terminal（整合版）

來源：使用者擁有的 `pi-pty-terminal` 0.1.0（MIT）；來源 README 說明其工具移植自 `opencode-pty-mcp`。此為來源快照加上本地 target 適配，不依賴原專案路徑。根 package/lockfile/Pi manifest 為唯一安裝單元；公開入口 `modules/pty-terminal/src/index.ts`。原始雜湊見 `docs/sources.json`，差異見 `docs/adaptations.json`。

## 工具

- `pty_spawn`：`{ command, args?, target?, cwd?, env?, cols?, rows? }`；`target` 預設 `local`，回傳 sessionId、本機 transport pid、target、transport。
- `pty_write`：`{ sessionId, data?, keys?, readAfterMs?, format? }`。`data` 支援 `\\x03`、`\\r`、`\\t` 等控制字元；`keys` 為具名按鍵陣列（Enter、Tab、Shift-Tab、Esc、Space、Backspace、Delete、Insert、Up/Down/Left/Right、Home、End、PageUp、PageDown、F1–F12、Ctrl-A..Ctrl-Z；不分大小寫，亦接受 `Ctrl+C`、`C-c`、Return、Escape 等別名），於 `data` 之後依序送出，兩者至少需一個；未知按鍵名回錯並列出支援清單，且在寫入任何內容前驗證。`readAfterMs`（0–60000）寫入後固定等待該毫秒再 drain 並一起回傳輸出（同 `pty_read` 格式；無輸出回 `ok`）；等待被取消時輸入已送出，session 保留。
- `pty_read`：`{ sessionId, timeoutMs?, waitFor?, settleMs?, format?, since? }`。預設 drain pending output 並等待 1000ms（上限 60000ms，`pty_wait_exit` 同）；每次輸出最多 2000 行／50KiB，超量部分留在 buffer，下次可繼續讀取，內容末尾提示剩餘字元數。
  - `waitFor`：JavaScript RegExp 原始碼（不含斜線／flags，multiline，最長 200 字元，拒絕 `(a+)+` 類巢狀量詞），對**已剝除 ANSI** 的未讀輸出比對，出現即返回；`settleMs` 為「安靜多久視為完成」（兩者併用時先匹配再等安靜）。皆受總逾時 `timeoutMs` 限制（設定 `waitFor`／`settleMs` 且未給 `timeoutMs` 時預設 5000）；逾時會在輸出後標示 `waitFor not matched before timeout`，輸出仍保留未讀。無效 regex 回可操作錯誤。取消只中止等待，session 與輸出保留。
  - `format`：`raw`（預設，保留控制碼）或 `text`（剝除 CSI／OSC／DCS 等 ANSI 控制碼；不做螢幕快照或游標還原）。截斷點不會落在 escape 序列中間；`text` 只計可見位元組，結尾尚未完整的序列會留待下次讀取（session 結束後才丟棄）。緩衝中只剩未完整序列時，預設讀取會繼續等到 `timeoutMs`，不會立即回傳空內容（設定 `waitFor`／`settleMs` 時依其條件返回，可能回空內容並保留該片段）；`raw` 不受影響。
  - cursor：每個 session 的輸出帶單調遞增 cursor（UTF-16 字元數），輸出後以 `[cursor a-b]` 標示本次內容範圍。`since` 從該 cursor 重讀仍在 buffer 內的輸出，**不 drain**（預設仍是讀取即清空）；`since` 早於 buffer 起點時回報 `dropped` 範圍，超過最新 cursor 則報錯。ring buffer 保留已讀與未讀輸出（共 2 Mi 字元）；溢出導致未讀輸出遺失時，下次輸出開頭標示 `[pty-terminal: N earlier characters were dropped (cursor a-b) ...]`。
  - 回傳瘦身：模型可見文字只含輸出與必要註記（cursor、`session exited`、waitFor 逾時）；target 為 local、signal 為 0、錯誤中已有的欄位等預設值不輸出；`pty_spawn` 只回 `sessionId`（非 local 才加 `target`），PID／transport 等完整資料與 renderer 細節放在 `details`。
- `pty_resize`：調整 terminal cols/rows。
- `pty_wait_exit`：回傳 transport exitCode，等待逾時回傳 `exitCode: -1` 並附 `timedOut: true`（shutdown 造成的 -1 不含此欄位）；SSH exit 255 可能是連線錯誤而非遠端結束碼，結果會附 `note` 警語。未知 target 錯誤會列出已設定（經宿主 trust 過濾後）的 target 名稱，不含 host／cwd 等值。分工：一次性指令用 shell、長時間背景執行用 shell background job，需持續輸入的互動程式／TUI 才用 PTY；PTY 無結構化 exit code。
- `pty_kill`：終止本機 transport；POSIX 預設 SIGHUP，僅接受 SIGHUP／SIGINT／SIGQUIT／SIGTERM／SIGKILL，逾時（2 秒）未結束會升級為 SIGKILL；Windows 使用 backend 無 signal 的終止操作（signal 參數不適用）。只有 transport 確認已結束才釋放 session（結果 `released: true`）；kill 失敗或仍在執行時保留 session（可重試，shutdown 仍可清理），不再吞掉錯誤。
- `pty_list`：列出本 session 保留的 active/exited PTY 與 target。

只有 spawn 指定 target；後續使用 sessionId。不改其他 shell/file 工具的執行位置。PTY 合併終端輸出並可能有 ANSI 控制碼，不提供逐指令結構化 stdout/stderr/exit code；互動 shell 的 exitCode 是 shell 結束碼。

## TUI 顯示

七個工具都有 call/result renderer，顯示 session、target、local transport PID、輸出與 transport exit／逾時狀態；list 收合列出前三筆，展開最多五十筆。read 以清理 ANSI／控制字元的文字預覽顯示，收合最多十二行，展開看已回傳內容；不是 terminal emulator，完整畫面控制碼仍保留於模型可見 output。write 不預覽輸入，spawn 不預覽 args/env；這不是全面敏感資料遮蔽。kill 明示 session 已釋放／termination requested，不冒稱遠端程序樹停止。Renderer 只改 UI，不修改工具結果、activation、target resolution 或 PTY lifecycle，也不執行／drain PTY。

## 設定

在 Pi 的 user settings 或受信任專案 `.pi/settings.json` 加入（不會自動寫入）。`targets` 說明如下，`env` 見後：

```json
{
  "pi-pty-terminal": {
    "targets": {
      "linux": {
        "transport": "wsl",
        "distribution": "Ubuntu",
        "cwd": "/home/user/projects/pi-better-tools"
      },
      "macos": {
        "transport": "ssh",
        "host": "mac-dev",
        "cwd": "/Users/user/projects/pi-better-tools"
      }
    }
  }
}
```

`local` 是保留內建名稱，不使用設定覆寫。Target name 為英數開頭，後續只接受英數、`_`、`-`。每次 remote spawn 使用 Pi `getSettings()` 有效、trust-aware settings；手動修改後 `/reload`。未知 target、錯誤設定、非絕對 POSIX cwd 不回退 local。target entry 僅接受上例欄位；host alias 可使用 `user@host`，連接埠／金鑰／ProxyJump 放在使用者 SSH config，不接受密碼或自由 SSH options。

```json
{ "target": "linux", "command": "bash", "args": ["-l"] }
```

```json
{ "target": "macos", "command": "zsh", "args": ["-l"] }
```

`cwd`／`env` 指目標程式；cwd 可覆寫 target 預設路徑，不把 Windows cwd 自動映射。遠端 env 僅傳明確指定的值，名稱須符合 POSIX；本機 SSH client 仍繼承本機環境。WSL 使用 `wsl.exe --distribution … --cd … --exec env -- …`，僅 Windows host 支援，需 WSL 支援 `--cd`。SSH 使用本機 `ssh -tt`，遠端須有 POSIX 相容 login shell、`sh` 與 `env`；參數逐一 POSIX quote。金鑰／SSH agent 認證、`BatchMode=yes`、ConnectTimeout=15，不停用 host key 驗證，也不另外覆寫 `StrictHostKeyChecking`（沿用使用者 ssh config／known_hosts，避免破壞 accept-new 設定）；另設 ServerAliveInterval=15、ServerAliveCountMax=3 偵測斷線。請先自行驗證主機並建立 known_hosts。遠端 command 不可為空，也不可形如 `KEY=value`（`env` 會當成環境變數賦值；請改用 `env` 參數）。SSH config 的 ForwardAgent/SendEnv 等仍由使用者負責。

### 環境變數過濾（選用）

預設不變：本機 PTY 繼承整份 `process.env`（再疊加 `TERM` 與 `pty_spawn` 的 `env`）。在同一 `pi-pty-terminal` 命名空間加入 `env` 後才啟用過濾：

```json
{ "pi-pty-terminal": { "env": { "allow": ["PATH", "HOME", "LANG", "LC_*"], "deny": ["AWS_*", "*_TOKEN"] } } }
```

- `allow`：存在時只傳入符合的變數（空陣列＝一個都不繼承）；`deny`：移除符合的變數，在 `allow` 之後套用。名稱為英數／底線，可用結尾 `*` 表示前綴（不支援其他萬用字元）；Windows 比對不分大小寫。無效設定（型別錯誤、未知鍵）會使 `pty_spawn` 失敗，不會退回不過濾。
- 設定來源為 `pi.getSettings()` 的有效、trust-aware 結果，與 `targets` 相同：未信任專案的專案層 `.pi/settings.json` 由宿主排除，不會生效；每次 spawn 重新讀取，手動修改後 `/reload`。
- 只過濾**繼承**的本機環境（含 WSL／SSH client 程序，故 Windows 上請保留 `SystemRoot`、`PATH` 等 client 需要的變數）；`pty_spawn` 明確指定的 `env` 一律傳入，遠端 env 仍僅傳明確值。這是降低意外洩漏的衛生措施，不是 sandbox。

## 安裝及驗證

從根目錄執行 `npm ci --ignore-scripts`，再明確執行 `npm run pty:install`（只 rebuild node-pty 的 native setup；無預編譯支援時需本機編譯工具）。使用符合根 manifest 的 Node 與 Pi 1.0.0 開發基準。原來源採用的 `node-pty` 1.2.0-beta.14 保留為固定 runtime dependency，未宣稱 beta 等同 stable 或所有 OS/architecture 都已實測。

根 manifest 的 npm 12 `allowScripts` 只允許固定 `node-pty@1.2.0-beta.14`，未允許任意 dependency scripts。`pty:install` 用目前 npm CLI／Node subprocess（無 shell）重建此套件，僅移除 npm run 帶入的 `npm_config_allow_scripts`（含大小寫變體），讓 project policy 生效；保留其他設定／環境，不修改使用者全域 npm 設定。一般 consumer 安裝須自行核可其 project 的 native setup；dependency 的 policy 不代表 parent project 自動核可。

根 `npm run typecheck`／`npm test` 包含此模組；loader 與真實 production tarball 使用真正本機 PTY。WSL/SSH argv/settings 單元測試不等於真實遠端連線驗證。原來源 POSIX shell 測試改用平台原生 Node fixtures，保留互動、drain、exit 及 kill 斷言。

啟用前停用獨立 `pi-pty-terminal`，避免工具重複註冊；不自動修改全域設定。原七個工具 activation 交由 Pi；explicit allowlist 需加入工具名稱，no-tools/exclusions 不繞過。

## 安全與 lifecycle

任意指令以 target 使用者權限執行；不是 OS sandbox。WSL 可存取 Windows 掛載檔案，SSH 可改遠端專案。GitHub 同步、commit/push/pull 不自動執行；跨平台測試前自行確認同一 commit 及乾淨 working tree，各平台自行安裝 dependencies。

`session_shutdown`（含 reload）清理本機 PTY，關閉 transport 不保證遠端 descendants/背景程序停止；不呼叫 `wsl --shutdown`。建立 session 不等於 SSH/WSL 握手或命令成功，必須 read 輸出及 wait_exit。操作取消不自動關閉持續 session；需要時明確 kill。每個 session 輸出為 ring buffer（2 Mi 字元），超過時丟棄最舊內容，下次 `pty_read` 開頭會標示被丟棄的字元數；同時最多 16 個 session（超過 spawn 失敗；已 exited 的 session 會讓位），cols 最大 500、rows 最大 200；已 exited 且未釋放的 session 於結束 10 分鐘後自動回收。
