# Shell Tools

覆寫 Pi 內建的 `bash` 與 `powershell` 工具，將以秒為單位的 `timeout` 改為以毫秒為單位的「輸出停滯逾時」`timeoutMs`。其餘行為（輸出處理、renderer、session 環境、PowerShell UTF-8、Bash `shellPath`／`shellCommandPrefix`）沿用 Pi 內建實作。

## 工具

兩個工具共用相同 schema（不允許額外欄位）：

| 參數 | 型別 | 說明 |
|---|---|---|
| `command` | string（必填） | 要執行的 shell 指令 |
| `timeoutMs` | integer（選填，1 ～ 2147483647） | 輸出停滯逾時，單位毫秒 |
| `background` | boolean（選填，預設 false） | true 時立即回傳背景工作 receipt，完成後自動喚醒 owner session |

- `bash`：使用 Pi 的平台 shell 解析；Windows 需安裝 Git Bash 或設定 `shellPath`。
- `powershell`：僅支援原生 Windows；其他平台即使有 `pwsh` 也不提供此後端。不套用 Bash 的 `shellCommandPrefix`。

兩者皆以 `defaultActive: false` 註冊：載入本擴充不會啟用未被選取的 shell，是否啟用由 Pi 預設 loadout、`defaultTools`、`--tools`、排除設定或 `setActiveTools()` 決定。

## timeoutMs 行為

| 輸入 | 效果 |
|---:|---|
| `20000` | 連續 20 秒沒有輸出即停止 |
| `120000` | 連續 120 秒沒有輸出即停止 |
| `2147483647` | 不逾時（哨兵值，不啟動計時器） |
| 省略 | 不逾時 |

- 計時於 shell 開始執行時啟動，每收到一個 stdout／stderr 資料區塊即重新計時；只有輸出停滯達該時間才會逾時。持續有輸出的指令可執行超過 `timeoutMs`。
- Pi 內建的絕對計時器對此覆寫停用。內部以 `timeout:<秒數>` 丟出，宿主會格式化為 `Command timed out after N seconds`；本擴充改寫為 `Command stopped: no output for N seconds (timeoutMs idle timeout)`，以符合「輸出停滯」語意。
- PowerShell 工具的宿主選項不支援 `shellPath`／`shellCommandPrefix`，這兩項設定僅套用於 Bash。
- 非正數、小數、非安全整數、超過上限的值會被拒絕。
- 新的呼叫若帶舊版 `timeout`（秒）欄位會直接報錯，請改用 `timeoutMs`；舊 session 紀錄中的 `timeout` 仍可正常顯示。
- TUI 以秒顯示（例如 `timeout 20s`）。
- 省略或使用哨兵值不會停用取消：`AbortSignal` 仍會交由 Pi 的 process tree 終止機制處理。逾時只是停滯門檻，不保證啟動與清理在該時間內完成。

### Codemode

```javascript
const result = await tools.bash({ command: "printf hello", timeoutMs: 20000 });
text({ output: result.output, exitCode: result.exit_code });
```

Windows 上可用 `tools.powershell({ command, timeoutMs })`。該 shell 必須已被選取，載入本擴充不會自動讓 codemode 可用。

## 背景工作

```javascript
const receipt = await tools.bash({ command: "npm test", background: true });
// { jobId, status: "running", liveLogPath }，不是完成結果，沒有 exit_code。
text(receipt);
```

- 同步模式（省略／false）維持原有 `output`、`exit_code`、`wall_time_seconds` 等 codemode 格式；`outputSchema` 為原有完成結果與 receipt 的 union。
- `liveLogPath` 在 receipt 回傳前已建立。執行中可用 `read` 查閱；完成後通知提供相同有效 `logPath`，沒有 rename 競態。檔案沒有新內容不代表工作已完成。
- 新增 `shell_job_status({ jobId })` 與 `shell_job_cancel({ jobId })`。兩者均為 `defaultActive: false`，需要以 `--tools`、`defaultTools` 或 `setActiveTools()` 明確選取；它們不啟用或執行任何未選取的 shell。背景提交仍透過已選取的 `bash`／`powershell`。只有 shell 的 loadout **不能呼叫 status/cancel**；若需要管理，先請使用者選取這兩個工具（例如 `--tools bash,shell_job_status,shell_job_cancel`）。description／receipt 提供此限制，不暗中呼叫 `setActiveTools()`；未選取時只能讀 log 與接收完成 followUp。
- status 回傳 `jobId`、`status`、`tool`、來源 `toolCallId`、log 路徑、`outputTruncated`，完成時另含可取得的 `exitCode`、bounded `output` 或 `error`。狀態為 `running`／`cancelling`／`completed`／`failed`／`cancelled`／`timed_out`。只有 owner session/runtime 能查詢或取消。
- cancel 是終止要求：先回 `cancelling`，等待宿主 runner 結束後才標示 `cancelled`；不宣稱已驗證所有 descendant process 清空。取消、逾時、執行失敗不偽造成功 exit code。
- 完成先保存結果、關閉 log，再以 `shell-job-completed` custom message 呼叫 `pi.sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })`。主 agent 忙碌時排後續處理，閒置時可自動接續；同個事件迴圈的完成事件合併通知。command output 明確標記為不可信資料，不提升為 system 指令。sendMessage 不是送達確認，通知不保證 exactly-once；結果可用 status 查詢。
- 接受前仍檢查工具 signal；接受後使用 job-owned `AbortController`，主回合 signal 不會取消已接受的背景工作。`timeoutMs` 仍由所有 stdout／stderr 區塊刷新，即使輸出已達保留上限亦同；省略／哨兵值不啟動 idle timer。Bash 有效 trust-aware 設定在提交時捕獲，PowerShell 保留宿主 UTF-8。
- 每個 runtime 最多 **8 個 active（含 cancelling）**，不排無限佇列；超額直接拒絕。最多保留 **32 個工作**，新提交時移除最早的已完成工作與其 log。
- 每個背景 log 只保存最前 **1 MiB**，bounded result 最多 **32 KiB decoded UTF-8 或 1000 行**（raw forwarding 僅最前 **10,922 bytes**，保留最壞 invalid UTF-8 → U+FFFD 三倍膨脹餘裕）；超額仍持續消費 stdout／stderr，但不保存後續輸出，`outputTruncated: true`。背景 log **不是完整輸出**，最多約 32 MiB/runtime；同步原有完整輸出行為不變。log 使用暫存目錄，POSIX 檔案為 `0600`，Windows 沿用 ACL；輸出可能包含機密。
- quit／reload／new／resume／fork 的 `session_shutdown` 會停止接受、取消所有 jobs、抑制舊 generation 通知、最多等待 2 秒宿主 cleanup，再關閉／移除背景 log。背景工作不跨 replacement/reload 持續，沒有 daemon 或自動恢復。異常強制退出或 I/O 清理失敗仍可能留下 bounded 暫存檔／orphan process，不能保證 process tree 全部已停止。
- SDK 嵌入式宿主必須 **`await runtime.dispose()`**，讓宿主發送 `session_shutdown` 並等待 extension cleanup。單獨呼叫同步 `session.dispose()` 不保證發送此事件，**不能當作背景退出清理 API**。若執行／輸出／通知時觀察到 owner getter 已失效，會 fail closed、取消並清理已觀察到的工作、抑制通知；不使用輪詢 timer，因此安靜且沒有後續 callback 的工作不保證立即偵測，仍需正確 runtime dispose。
- 長例外訊息在判定原始 timeout 尾部後才縮減，保留頭尾與省略標記；超長輸出不會吞掉 timeout 狀態或尾部診斷。
- owner 綁 session，不綁目前 branch；來源 toolCallId 隨通知提供，切換 branch 不會撤銷背景副作用。所有工作與主 agent 共用 workspace，避免並行修改同一檔案；必要時自行使用獨立 worktree。
- 背景失敗仍沿用下面的選用 failure debug log（其既有不自動輪替政策不變）。query／control 不適用 shell。

## Bash 設定

每次執行 Bash 時透過 `pi.getSettings()` 讀取宿主的有效設定（全域、受信任的專案設定與 SDK 記憶體覆寫）：

| 設定鍵 | 說明 |
|---|---|
| `shellPath` | Bash 執行檔路徑；沿用 Pi 對 `~`、file URL、Windows 磁碟路徑的正規化 |
| `shellCommandPrefix` | 加在每個 Bash 指令前的前綴 |

本模組不會自行重讀設定檔。修改持久化設定後請使用 Pi 的 `/reload`（或嵌入式宿主呼叫 `settingsManager.reload()`）；SDK `applyOverrides()` 的變更在下次執行時生效。

## 失敗除錯日誌（選用，預設關閉）

在 `~/.pi/agent/settings.json` 加入：

```json
{
  "pi-shell-tools": {
    "debugLog": true
  }
}
```

- 只有字面布林值 `true` 會啟用。每次失敗時才讀取此檔，修改後不需 `/reload`。
- 開關固定讀取使用者家目錄下的 `~/.pi/agent/settings.json`；專案設定、SDK 覆寫與 `PI_CODING_AGENT_DIR` 都不會改變開關或日誌位置。檔案不存在、無法讀取、JSON 無效或非一般檔案時視為關閉。
- 本模組的 `bash`／`powershell` 執行拋出例外（含逾時、取消、輸入驗證錯誤）或回傳 `isError: true`（例如非零結束碼）時，每次失敗寫入一個檔案：

```text
~/.pi/logs/pi-shell-tools/<UTC時間戳>-<ULID>.json
```

- 內容（`schemaVersion: 1`）包含：時間戳、process id、工具名稱、toolCallId、cwd、sessionId、耗時毫秒、原始輸入（含 `timeoutMs`），以及例外（name／message／stack／cause）或失敗結果。字串超過 65,536 字元時保留前後各 32,768 字元並加上省略標記，原始輸入／結果不受影響。
- 成功呼叫不產生日誌。診斷 I/O 的等待上限為 2 秒，寫入屬 best-effort，失敗最多警告，不改變原本的工具結果或例外。
- 日誌可能包含指令與含機密的輸出；不會自動輪替或清理，請自行刪除。POSIX 上新檔／目錄要求 `0600`／`0700`，Windows 依檔案系統 ACL。本模組不會自動修改你的設定來啟用日誌。

## 範圍與限制

- 只改變模型可呼叫的 shell 工具，不影響 `!`／`!!` 使用者 shell 指令或 `pi.exec()`。
- 同名 shell 工具應只由一個擴充擁有；本模組不會與 SSH、sandbox 或 spawn-hook 覆寫自動組合，也不保證保留其執行限制，不要把載入順序當作安全邊界。
