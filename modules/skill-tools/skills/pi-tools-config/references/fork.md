# Fork：繼承對話的獨立 Pi 工作

## 指令與工具

- `fork { task, title? }` 非同步受理，稍後於 canonical turn_end 取得對話快照。
- `fork_status { jobId? }` 查同 owner session 工作。
- `fork_cancel { jobId }` 要求取消，不代表實際 child close。
- 共用 `/background-jobs fork` 看 TUI 清單；完成的原生對話可用 Pi `/resume` 載入，執行中不要當 live attach 使用。

## Config 與作用範圍

**沒有專屬 JSON config 鍵。** 三工具均 `defaultActive: true`，載入 extension 後預設啟用，不需新增 config。宿主的 `--tools` allowlist、`--exclude-tools`、`--no-tools` 與手動停用仍優先；Subagent／Fork child 仍不註冊這三個工具。

Fork 繼承 parent 有效 cwd、model／thinking、工具與資源，工具參數不提供這些 override。它與 Subagent 的乾淨 context 不同，不會建立 git worktree、同步 parent 後續訊息或合併檔案。

Metadata／有界結果在 `<cwd>/.pi/forks/<jobId>.json`，原生對話在來源 sessionDir；這些是執行紀錄，不是可用來修改能力／恢復工作的設定檔。不要手改指紋或刪除仍有 writer 的對話。

## 啟用條件與限制

- 每個 session 都應載入管理 extension，避免切換到沒有此入口的 session 後失去 lifecycle 管理；不要為啟用模型工具而移除管理入口。
- Fork 可使用其選取的 Subagent，但不能再建立 Fork；所有 Subagent child 亦不可建立 Fork。這是工具契約，不是 OS sandbox。
- 最多4個未完成 Fork；與 parent 共用 workspace，避免同時改同一檔案。
- Quit／reload 會扇出取消；先處理必要背景工作。完成只回報來源 session，不等於永續 OS daemon。

先確認工具選取與來源 session，不為了驗證 config 就啟動付費模型工作。
