# File Audit：近期檔案窗口與增量檢查

## 指令與設定範圍

無 config 檔、環境變數、模型工具或持久化活動日誌；不修改全域 settings/auth。

- `/file-audit`／`status`：顯示成功 read/write/edit/note 的近期活動，不讀檔案內容。
- `/file-audit check`：只檢查目前候選與使用者 cwd 下的 provenance，不自動刷新雜湊。
- `/file-audit clear`：清空觀察、撤銷舊檢查，保留目前限制。
- `/file-audit limits --window 4 --max-files 50`：只修改本 session；預設 4 runs／50 個不同檔案，可設 1–30／1–500，不接受 0 或無限。縮限立即淘汰，非法參數不部分套用。

run 指 before_agent_start（user/custom 均計入），不是每次工具呼叫。容量在納入時生效、同檔更新真正最後存取順序。note 路徑來自成功結構化結果，不猜檔名、不保存正文，與後續 read/edit 同檔共用名額。只觀察載入／重設後活動，不回掃 session history；start/reload/resume 恢復預設，tree 清空觀察但保留 limits。

## 檢查來源與限制

check 只讀 cwd 下 optional 的 `docs/sources.json`、`docs/adaptations.json`、`docs/native-modules.json`，不向祖先找根、不掃目錄或來源 sourcePath。缺 metadata 時 unavailable；新 note 無紀錄時 untracked，都不是通過。此命令是近期增量檢查，不等同專案全量驗證，也不判定哪個 session 修改了檔案。

三份 metadata 合計 8 MiB／50000 inventory 項目；候選單檔 8 MiB、合計 32 MiB；只允許一個 check。範圍外、非一般檔案、已知 credentials/state 路徑不讀內容。顯示最多 10 筆／8 KiB，超限與未檢查會明示。容量與窗口外活動可能未驗證就淘汰，不保存完整遺漏清單。

## 載入／停用與安全

根 package 的 `modules/file-audit/src/index.ts` 為入口。透過 Pi package extensions filters 排除此入口並 reload 即停用；單純 `--tools`／`--no-tools` 不控制 slash command。不要因此修改已選工具、trust 或個人設定。TUI 手動命令才執行檢查；RPC／JSON／print 不掃描或啟動模型。沒有 watcher、排程、背景模型、主動通知或 OS sandbox；取消不保證已開始的 OS I/O 即刻停止。
