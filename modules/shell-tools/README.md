# Shell Tools

覆寫 Pi 內建的 `bash` 與 `powershell` 工具，將以秒為單位的 `timeout` 改為以毫秒為單位的「總時限」`timeoutMs`（自指令啟動起算）。其餘執行行為（輸出處理、session 環境、PowerShell UTF-8、Bash `shellPath`／`shellCommandPrefix`）沿用 Pi 內建實作。結果 renderer 沿用宿主的輸出清理、警告與計時，只調整輸出區塊的 TUI 排列；命令呼叫的 TUI 預覽限制如下。

## 工具

主代理的兩個工具共用相同 schema（不允許額外欄位）：

| 參數 | 型別 | 說明 |
|---|---|---|
| `command` | string（必填） | 要執行的 shell 指令 |
| `timeoutMs` | integer（選填，1 ～ 2147483647） | 總逾時，單位毫秒，自指令啟動起算（前景與背景相同） |
| `background` | boolean（選填，預設 false） | true 時立即回傳背景工作 receipt，完成後自動喚醒 owner session |

- `bash`：使用 Pi 的平台 shell 解析；Windows 需安裝 Git Bash 或設定 `shellPath`。
- `powershell`：僅支援原生 Windows；其他平台即使有 `pwsh` 也不提供此後端。不套用 Bash 的 `shellCommandPrefix`。

主代理的 `bash`／`powershell` 與 `shell_job_status`／`shell_job_cancel` 均以 `defaultActive: true` 註冊（使用者要求）：載入本擴充即預設啟用，不需 `defaultTools`。宿主 `--tools` allowlist、`--exclude-tools`、`--no-tools` 與手動停用仍優先；`reload` 會重新註冊並再次啟用。不改 settings、不呼叫 `setActiveTools()`。

## Managed subagent 前景工具

由 Subagents 經既有 managed admission／argument builder／startup guard 啟動的 child（含 new、resume 與 ready-query），使用同名 `bash`／`powershell` 的專用前景 definition：schema 只有 `command`／`timeoutMs`，description／prompt guidelines 不介紹背景 receipt，outputSchema 只保留宿主同步完成結果；不註冊 `shell_job_status`／`shell_job_cancel`，也不建立背景 registry／通知／面板。直接 `execute()` 繞過 schema 時，任何 `background` 欄位（包括 false、undefined 或 null）均在讀取 execution/effective Shell settings（`pi.getSettings()`）／建立 backend／spawn 前拒絕。這不表示零診斷 I/O：拒絕仍走既有 failure diagnostics，依個人家目錄 opt-in 設定決定是否保存失敗日誌，不移除或自動啟用該功能；測試須隔離 home。

身份來自 parent 明確加入 `PI_SUBAGENTS_GUARD` 的 `shellMode: "foreground-v1"`；Shell factory 與 guard 共用消耗 helper，先載入者立即刪除環境 handshake，process-local copy 保留整個 child process 生命週期與 reload。不是以 RPC／JSON／cwd／prompt 推測；一般 shell／手動 Pi 孫行程不繼承 managed 身份。此為可信擴充之間的私有協定，不是抵抗惡意擴充或 shell 手動仿造環境的安全邊界。

同 process guard reload 僅對同一已驗證 invocation 的原 startup receipt 做只讀重驗證（配置／trust、bigint 檔案身份／固定預期 size、原始 Buffer bytes 精確 equals、讀前後 descriptor／path metadata），不以容錯 UTF-8 解碼字串比對；新 invocation 仍 exclusive 建立，不覆寫外來／變造 receipt、不重建遺失檔案。這些是離散檢查點的觀測，不是原子快照、永久禁止外部修改或讀取記憶體硬上限。拒絕或 receipt 驗證故障直接終止 child，不假定一般 `session_start` handler throw 可以停止 Pi。完整政策與驗證邊界見 Subagents README。

主代理的 schema、背景 receipt／管理工具、工具選取、trust-aware 設定及取消不變。前景 child 與主代理共用執行核心、停滯計時器、宿主輸出與 process-tree 取消委派，不複製 extension；仍以 `defaultActive:false` 保留 loadout（managed child 的 loadout 由 Subagent argument builder 決定，不隨主代理預設啟用）。ready-query 原本的 `--no-tools` 與遞迴 exclusions 亦不變。前景 child 的停滯錯誤提示不建議 `background:true`。這不限制 `!`／`pi.exec()`／自行建立 OS process，也不是 OS sandbox。

## 命令呼叫 TUI 預覽

`bash`／`powershell` 的命令呼叫區塊最多 **5 個實際終端行**（包含窄欄折行）。超過時顯示前 4 行，第 5 行為 `...`；欄寬足夠時仍保留 `(timeout Ns)`。未超過者完整呈現，resize／streaming 更新重新計算。這個上限只套用呼叫預覽，不縮減實際執行命令、模型 arguments、結果輸出或背景通知；宿主外層內距另計。沿用宿主 Text component reuse 與 timing state，不改 timeout／取消／activation 行為。

## 終端輸出 TUI

`bash`／`powershell` 的終端輸出每個實際顯示行（含空白行與折行）以 `▌` 標示。收合保留最後 **5 個實際終端行**；省略提示改為 `65 earlier lines, ctrl+o to expand`，位於輸出區塊下方、宿主警告／`Took …`（執行中為 `Elapsed …`）上方，前後以空白行分隔。快捷鍵由目前 keybindings 產生，窄欄提示會截短；行數先扣除 `▌` 寬度再依折行計算，resize 時重新計算。展開顯示已保留的完整輸出並保留 `▌`，不顯示 earlier-lines 提示。

這是 Pi 1.4.0 宿主元件排列的顯示層適配：保留宿主的 ANSI／binary 清理、image fallback、full-output／truncation 警告、計時 state 與元件 reuse，不解析命令輸出判斷 UI 狀態。警告與耗時不加 `▌`。背景接受 receipt／完成通知、模型結果、session、命令執行與 timeout／取消語意不變；不影響 `!`／`!!` 使用者 shell。極窄欄下宿主警告／計時 Text 的既有最小寬度行為不在此適配範圍。

## API 中斷工具卡片

載入 Shell extension 即註冊公開 `registerToolRenderer` resolver，套用有完整 call/result renderer 的工具（不限 bash，亦含 read 等）；不啟用任何未選工具。未載入 Shell、缺少 renderer 或其他 resolver 優先完全取代者保留宿主行為。

只有 assistant `stopReason:error` 中的 toolCall ID、沒有 execution start/end 證據、卡片 `executionStarted:false`，且結果精確符合宿主合成的單一 provider error 文字／無 details，才換中性色。`API interrupted · recovery not confirmed` → 觀察到後續 `before_provider_request` 時 `Resuming API request…` → 正常 assistant `message_end` 時 `API response recovered`。始終明示 `Previous tool call was not executed.`，不把舊 call 標成成功；新 call 仍依自己的真實結果顯示。展開保留清除控制碼的 provider diagnostic。取消、input／settled 邊界切斷未確認續接，真正工具 error／exit code 不隱藏。

Default-shell 卡片改由 self-shell 重建原有 Box，避免外層留白仍紅；正常 call/result renderer、lastComponent/state、outputPad、圖片與展開維持宿主流程，原 self-shell 正常路徑沿用。事件 invalidate，沒有 ticker／輪詢；records／execution IDs／callbacks 各最多512，診斷最多4096字元；過大診斷保留原 error，不強行推測。session replacement 清除狀態，reload／歷史僅掃 active branch 最後4096筆、排除有真實 toolResult 的 ID，保守顯示 interrupted，不從後來不相關回答推測歷史 retry 成功。大量歷史超出範圍或 IDs 超出追蹤上限仍可能保留原卡片。

只改工具卡片 UI，不修改 content/details/structuredContent、message、session 檔、工具副作用或 API 重試策略；Pi 原生 assistant error 仍保留。這不是官方 auto_retry_start/end 訂閱，沒有精確 attempt／倒數／耗盡資訊；後續請求也可能由其他合法 continuation 觸發，因此使用 Resuming 而非宣稱官方 retry 次數。真實 loader/hooks/ToolExecutionComponent 回歸無 provider 呼叫；未進行付費 API 中斷或人工 fullscreen 驗證。

## timeoutMs 行為

| 輸入 | 效果 |
|---:|---|
| `20000` | 啟動後滿 20 秒即停止，即使仍持續輸出 |
| `120000` | 啟動後滿 120 秒即停止 |
| `2147483647` | 不逾時（上限值，相容保留；工具描述已改寫為「省略即不逾時」） |
| 省略 | 不逾時；背景 job 會自動啟動 Monitor（見下） |

- `timeoutMs` 是總時限：自指令啟動起算，到期即終止，即使指令仍持續輸出；請設得高於預期最長執行時間，長時間工作可省略或調大。`background: true` 套用相同總時限。
- 計時使用宿主內建的絕對計時器，於指令啟動時開始，輸出不會重置；行程啟動時間計入總時限，`timeoutMs` 過小（例如數十毫秒）可能在指令尚未輸出前就被終止，建議使用數秒以上的值（工具描述已註明）。本擴充不再自行實作閒置（idle）計時器。
- 內部以 `timeout:<秒數>` 丟出，宿主會格式化為 `Command timed out after N seconds`；本擴充改寫為 `Command stopped: exceeded the N second time limit (timeoutMs total timeout). If the command legitimately needs more time, increase or omit timeoutMs. Use background:true separately if you want asynchronous execution.`，點名 `timeoutMs` 並提示處置。
  只改寫宿主附加在錯誤訊息**尾端**的診斷（`appendStatus` 的最後一行）；命令輸出中間出現相同字樣保持原樣，改寫後不再匹配故在多層 catch 中冪等。背景 job 的 `timed_out` 仍只由尾端 `(timeoutMs total timeout)` marker 判定，不信任命令輸出。回歸測試：`tests/timeout-diagnostics.integration.test.mjs`（以 fake process backend，無實際等待）。
- PowerShell 工具的宿主選項不支援 `shellPath`／`shellCommandPrefix`，這兩項設定僅套用於 Bash。
- 非正數、小數、非安全整數、超過上限的值會被拒絕。
- 新的呼叫若帶舊版 `timeout`（秒）欄位會直接報錯，請改用 `timeoutMs`；舊 session 紀錄中的 `timeout` 仍可正常顯示。
- TUI 以秒顯示（例如 `timeout 20s`）。
- 省略或使用哨兵值不會停用取消：`AbortSignal` 仍會交由 Pi 的 process tree 終止機制處理。逾時只是啟動後的時間門檻，不保證啟動與清理在該時間內完成。

### 前景自動轉背景（兜底）

前景（非 `background`）指令未設 `timeoutMs` 時，啟動滿 180 秒仍在執行，會自動轉成背景 job，防止無限迴圈等情況卡住整個回合。**同一個 process 繼續執行，不重跑**：

- 工具呼叫立即回 job receipt（`Command still running after 180s … moved to a background job automatically`），結果改由完成通知／`shell_job_status` 取得；並依下節規則自動啟動 monitor。
- 交接前的 Esc／回合取消仍照前景行為終止 process；交接後 turn abort 不再停止它，需用 `shell_job_cancel`。與背景 job 語意一致。
- job 受理時（receipt 回傳前）就把 job 的取消訊號接到已接手的前景 process，不是等到延後一個 event-loop 邊界的 runner 才接：該邊界若因 owner 已被替換而永不執行，被接手的行程不能因此變成無人取消的孤兒。因此 `session_shutdown`／`shell_job_cancel` 對剛受理的 job 也在同一個同步步驟內中止底層 process。
- 交接前的輸出（前 1 MiB 與最近約 8 KiB）重放進 job log；交接前已送給宿主的輸出不會重複回灌，之後的輸出走 job 的 log／tail／上限規則。兩者之間若超過 1 MiB 會有未保留的間隙，job 標示 `outputTruncated`。
- 交接後不再更新該前景呼叫的串流顯示；job 名額（active 8／retained 32）不足或 owner 不可用時不交接，維持前景。
- 不適用：有設 `timeoutMs`（該總時限已是上限）、`background:true`、Subagent 前景 child（無背景能力）。
- 門檻可用 `settings.json` 的 `pi-shell-tools.autoBackgroundMs`（正整數毫秒；`0` 停用；其他值回到預設 180000）調整。
- 手動交接：互動 TUI 中前景指令執行時，該 tool call 的 message render **最後一行**顯示 `Alt+J: move running command/subagent to background`（muted，與 Pi 的 `N earlier lines, … to expand` 同型；尚未有串流輸出時掛在 call render，有 partial result 後改掛在 result render 底部，**不寫狀態列**）。按下即把目前所有前景 Shell 指令交給背景 job（同一 process、走同一條 handoff 路徑，回傳 receipt 讓主代理繼續）。提示只在該 call 真正被追蹤時出現，交接或結束後立即消失；每次 render 會記住該列的 `invalidate`，追蹤開始／結束時主動重繪，不依賴輪詢或固定 tick。與計時器不同，手動交接也適用於有 `timeoutMs` 的指令（總時限仍由原 process 的計時器執行）；無 UI（print／RPC）與 managed child 不提供。`Alt+J` 不是 Pi 1.4.0 預設綁定。快速鍵與登記表（`src/manual-detach.ts`，以 `globalThis` 共用；提示文字與列重繪輔助見 `src/detach-hint.ts`）和 Subagents 的前景轉背景共用：先載入的 extension 註冊一次，session shutdown 時釋放，一次按鍵轉換全部前景 Shell 與 Subagent 工作。
- 送出即交接：互動 TUI 中前景工作執行時，使用者送出一般文字（Pi 的 steer，非 follow-up、非 `/` 指令、非 RPC／extension 來源）會自動執行與 `Alt+J` 相同的交接（Shell 與 Subagent 前景工作一起轉背景），訊息照常以 steer 送達、不被攔截；無前景工作時不動作。`settings.json` 的 `pi-shell-tools.detachOnSteer: false` 停用（預設開）。交接後語意同 `Alt+J`：turn abort 不再停止，需 `shell_job_cancel`。測試：`tests/detach-on-steer.test.ts`。
- 測試：`tests/foreground-handoff.test.ts`（輸出記錄／重放）、`tests/auto-background.integration.test.mjs`（真實 extension＋host bash 定義，fake process，事件驅動，不等待真實門檻）。

### 背景 job 預設 Monitor

`background:true`（或前景自動轉背景）且未設定 `timeoutMs` 時，job 被接受後 Shell 經 `monitor-capability.ts` 的 rendezvous 請求已載入的 Monitor 啟動一個 `shell_job` 來源：`intervalMs` 180000、`wakeAgent:false`（僅 display、不要求模型回合）、`durationMs` 1800000（Monitor 上限）、label `auto: shell job without timeoutMs`。receipt 文字附上 monitorId 與 `monitor_stop` 提示。Best effort：`monitor_start` 未選取（allowlist／exclude／no-tools）、Monitor 未載入、owner／cwd 不符或 4 個 active 上限已滿時靜默略過，不啟用未選工具、不影響 job；Monitor 只讀取 snapshot，停止或到期都不取消 job。前景指令與有設定 `timeoutMs` 的背景 job 不啟動。自動 monitor 佔用 Monitor 的 active 名額。

### Codemode

```javascript
const result = await tools.bash({ command: "printf hello", timeoutMs: 20000 });
text({ output: result.output, exitCode: result.exit_code });
```

Windows 上可用 `tools.powershell({ command, timeoutMs })`。該 shell 必須已被選取，載入本擴充不會自動讓 codemode 可用。

## 背景工作

### 模型提示與提前停止

每回合透過 `before_agent_start` 注入共享 `pi_better_tools_background_lifecycle` system prompt section（與 Subagents 去重）。只在相關建立／管理工具被選取時存在；不啟用工具、不修改設定，保留其他 sections／custom／forced prompts。

- 通知抵達順序不等於工作完成順序；依 job／task／invocation ID 核對，不以舊通知覆蓋新版結果。
- log、partial 結論及 snapshot 只支持暫定結論；整個工作通過須有 terminal status／result 與可用退出／錯誤資訊。只有 log 時須明說尚未確認 runner 退出／cleanup。
- 已有充分結論且剩餘工作不再需要時，要求用已選取的 owned cancel 工具停止，不為等通知放著繼續跑。必要測試、寫入、checkpoint／commit／cleanup 則須完成並說明理由；提前取消不能宣稱完整驗證通過。
- 取消要求不等於 runner／process tree 已停止；等待完成通知，禁止輪詢／sleep 等通知，允許一次性核對終結／取消收尾。未選 cancel 時明說限制、不自動啟用或亂殺行程；可能需要提前停止的工作優先使用前景。

這是模型操作指引，不是從輸出文字自動取消的 runtime heuristic；既有 registry／通知／取消與清理機制不變。

### 即時 TUI 面板

Shell／Subagents／Fork 的 owner-bound `bind`／`refresh`／`clear` 共用 `src/widget-binding.ts`；只共用 UI context、producer token 與顯示更新，各自的資料投影、執行 registry、取消、通知及生命週期仍獨立。

Jobs 面板自動掛在輸入欄上方 `aboveEditor`，Shell＋Subagents **合計最多五個 job，每個兩行**（tool／command preview／短ID＋狀態），最多12行；窄欄截短不折行，高度不足減少列數，More 顯示省略數。只列目前 owner/runtime 的背景 Bash／PowerShell，running／cancelling 直到 registry settlement；取消要求不冒充程序樹已停止。Shell 顯示 Running／output received 或 no output observed，沒有輸出不自行推斷卡住；工具本身沒有模型用量帳本，固定顯示 `tokens N/A`，不推算命令內呼叫 AI 的 token。

`/background-jobs`／`more`／`all` 開有界浮層；`shell`／`subagents` 篩選，`collapse` 明確隱藏常駐面板，more／all 恢復。↑↓ 選取、Enter 詳細、Tab 最近完成／全部、Esc 返回／關閉回 editor，保持輸入草稿；只有主動開啟才取焦點，背景事件不重開浮層。Fullscreen 可左鍵點完整 More 標籤，一般模式保留 terminal mouse。完成逐項移出常駐面板，但 More 可查看目前 retained registry 的完整ID、命令預覽、開始／結束時間、exit、取消要求與既有 log 路徑／輸出 byte 統計；不讀 log／输出、不恢復跨 reload 或已淘汰工作。命令／ID 只做顯示層 ANSI／控制碼／bidi 清理，Unicode 按欄寬截短，不重寫原參數。

詳細頁（Enter）對**執行中**的 job 顯示記憶體副本：Subagent／Fork 為子行程的對話（沿用主 TUI 的 message／tool components），Shell 為該 job 自身輸出的有界尾端（上限 128 KiB，較早內容省略並標示）。`Ctrl+O` 展開／收合工具結果（與宿主 `app.tools.expand` 同鍵），`m` 切回既有 metadata（log 路徑、byte 統計、exit 等），`↑↓`／`PgUp`／`PgDn` 捲動、`End` 回到跟隨尾端，`Esc` 返回。副本只在記憶體，job 進終態（或淘汰／containment failure／shutdown）即釋放並退回 metadata；不寫 log、不進模型 context、不進 receipt／structuredContent，也不是第二份結果；面板變更指紋只取副本版本號，不含內容。非 TUI 模式沒有面板，因此不會建立副本。

共用 key `pi-better-tools-background-jobs`，純 UI helper 透過公開 pi.events rendezvous 協調；不共用 job registry，不替換 footer／Schedule Prompt 或移除其他狀態／widgets，footer 不重複 Jobs 摘要，不啟用未選 tools。僅 TUI+hasUI，RPC／JSON／print 不掛面板；單模組與兩種載入順序均支援。沿用 stdout／stderr、取消／完成事件更新（同一 event-loop 回合內的連續輸出 chunk 合併為一次重繪），無 polling／ticker／模型請求，owner／generation／producer lease／disposed pointer／shutdown 防護保留，UI 例外不改執行、通知或結果。只列背景工作，不列前景、其他 owner/runtime 或 OS 行程。等待背景工作結束後 `/reload` 載入。

```javascript
const receipt = await tools.bash({ command: "npm test", background: true });
// structuredContent: { jobId, status: "running", liveLogPath }，不是完成結果，沒有 exit_code。
// 模型可見文字僅 "job <id> running / log <path> / 下一步提示"。
text(receipt);
```

- 同步模式（省略／false）維持原有 `output`、`exit_code`、`wall_time_seconds` 等 codemode 格式；`outputSchema` 為原有完成結果與 receipt 的 union。
- `liveLogPath` 在 receipt 回傳前已建立。執行中可用 `read` 查閱；完成後通知提供相同有效 `logPath`，沒有 rename 競態。檔案沒有新內容不代表工作已完成。
- **模型可見文字已瘦身**（`structuredContent` 與 `outputSchema` 維持完整、不移除必填欄位）：receipt 只含 jobId、log 路徑與下一步提示；status／cancel／完成通知以 `compactJob` 輸出，省略預設值與重複欄位（`cancelRequested` 僅 true 時出現、log 路徑只在 running 或輸出被截斷時以 `log` 提供、不輸出 `toolCallId`／`startedAt`／`logBytes`／重複的 `logPath`、空 tail）。單一 status 不含 `command`；list 文字僅 jobId／status／command（80 字）／elapsedMs／exitCode／error；cancel 文字不含 output。完成通知為單一 JSON 陣列（含 command、output、error，標記為不可信資料），完整 metadata 留在 message `details`。一般（前景）shell 輸出由宿主產生，未更動。
- 新增 `shell_job_status({ jobId? })` 與 `shell_job_cancel({ jobId })`。兩者均為 `defaultActive: true`（直接曝光，不是 deferred，不經 `tool_search`）；被 `--tools` allowlist 或 `--exclude-tools` 排除時不可用，只有 shell 的 loadout 此時**不能呼叫 status/cancel**。receipt 以 `pi.getActiveTools()` 判斷：未啟用時只提示「用 `read` 讀 `liveLogPath` 尾端」，已啟用時才提示 `shell_job_status`；不暗中呼叫 `setActiveTools()`。
- status 省略 `jobId` 時列出此 session 的所有 jobs（running／cancelling 在前，其後依開始時間新到舊），每筆含 `jobId`、`status`、`tool`、`command`、`startedAt`、`elapsedMs`、`logBytes`。指定 `jobId` 時回傳 `jobId`、`status`、`tool`、來源 `toolCallId`、截短至 200 字元的 `command`、`startedAt`（ISO）、`elapsedMs`（完成後凍結）、`logBytes`、`cancelRequested`、log 路徑、`outputTruncated`，完成時另含 `exitCode`、`output`（head）、`error`。輸出被截斷或工作仍在執行時另含 `outputTail`（最後約 8 KiB）；工作執行中時模型可見文字只附最後 2000 字元（避免每次輪詢重複付費，完整 tail 仍在 `structuredContent`，更多內容請讀 `liveLogPath`）。未知 jobId 的錯誤會區分「已被淘汰（evicted）」與「不存在」，並列出 running jobs；active／retention 上限錯誤會列出占用名額的 jobs 並指出可取消或等待。狀態為 `running`／`cancelling`／`completed`／`failed`／`cancelled`／`timed_out`。只有 owner session/runtime 能查詢或取消。
- cancel 是終止要求：先回 `cancelling`（並設 `cancelRequested: true`），等待宿主 runner 結束後才標示 `cancelled`；若 runner 在取消送達前已產生成功結果，以該結果為準（`completed`，`cancelRequested` 仍為 true）；不宣稱已驗證所有 descendant process 清空。取消、逾時、執行失敗不偽造成功 exit code。
- 完成先保存結果、關閉 log、記錄 terminal journal，並加入本地待回報集合；以單次 `setImmediate` 合併**當時全部已完成待通知結果**，送出 `shell-job-completed` custom message。主 agent 忙碌也立即提交，不再等待整個 run 的 `agent_settled`；不等其他仍執行中的工作、不輪詢、不固定延遲。不同事件迴圈或已提交後才完成者屬下一批，不回改／回填舊訊息。面板仍只計 running／cancelling，不計待回報結果。
- Shell 與 Subagent 結果統一使用 `pi.sendMessage(..., { triggerTurn: true, deliverAs: "steer" })`。忙碌時交由 Pi 在目前 assistant＋tool batch 完成後插入，下一次模型請求可見；不插在 tool call／result 中間。閒置時自動觸發回合。若 provider 已在生成 final text，仍須等該則回答結束，不能追溯修改已發出的請求；遵循宿主 steeringMode／既有佇列與 abort 行為，不強迫被取消的主 run 再呼叫模型。
- 保留原 payload/schema、metadata 與逐項真實 status／exitCode。通知內含 `command`、`outputTruncated`，被截斷時附 log 提示（log 保留前 1 MiB）；command output 是回傳資料，不提升為 system 指令。提交前重檢 owner／generation 並防同步重入；同步提交失敗保留 pending／retention 保護，待新完成或下一個 lifecycle opportunity 再嘗試，不建立重試迴圈。`agent_settled`／compaction／tree handlers 僅提供 pending 重試機會，不是 busy gate、全宿主 idle gate 或新模型互斥。sendMessage 不是送達確認，非 exactly-once；異步宿主失敗仍以 status／journal 為準。
- 接受前仍檢查工具 signal；接受後使用 job-owned `AbortController`，主回合 signal 不會取消已接受的背景工作。`timeoutMs` 是自指令啟動起算的總時限（輸出不重置）；省略／哨兵值不設時限。Bash 有效 trust-aware 設定在提交時捕獲，PowerShell 保留宿主 UTF-8。
- 每個 runtime 最多 **8 個 active（含 cancelling）**，不排無限佇列；超額直接拒絕。最多保留 **32 個工作**，新提交時移除最早且已提交完成通知的終結工作與其 log；仍待回報者不可淘汰，若32個皆執行中或待回報，拒絕新提交，不丟棄既有結果。
- 每個背景 log 只保存最前 **1 MiB**；另在記憶體保留最後 **8 KiB** tail（`outputTail`）。head（`output`）加 tail 的 decoded 合計最多 **32 KiB**：raw forwarding 僅最前 **8,192 bytes**（`(32 KiB − 8 KiB) / 3`，保留最壞 invalid UTF-8 → U+FFFD 三倍膨脹餘裕），且不超過 1000 行；超額仍持續消費 stdout／stderr，但不保存後續輸出，`outputTruncated: true`。背景 log **不是完整輸出**，最多約 32 MiB/runtime；同步原有完整輸出行為不變。log 使用暫存目錄，POSIX 檔案為 `0600`，Windows 沿用 ACL；輸出可能包含機密。
- quit／reload／new／resume／fork 的 `session_shutdown` 會停止接受、取消所有 jobs、抑制舊 generation 通知、最多等待 2 秒宿主 cleanup，再關閉／移除背景 log；log 目錄移除並行執行並另有 2 秒上限，逾時不再阻塞 reload／dispose 及後續 shutdown handlers，晚到的刪除自行完成，未完成者留作 orphan（由 `owner.pid` 供後續清掃），不宣稱清理成功。背景工作不跨 replacement/reload 持續，沒有 daemon 或自動恢復。背景 log 目錄（`pi-shell-job-*`）移除以非同步 I/O 重試（Windows 暫時佔用）；retention eviction／受理失敗的刪除不阻塞 receipt，清理 pending 最多32筆，滿載或故障時保留 orphan 供後續人工檢查。每個行程第一次提交背景工作時啟動非同步 best-effort 清掃，不等待結果才回 receipt；以 opendir 串流最多檢查1024個 tmpdir entries（含非 matching entries），不保證一次清空所有 crash 殘留。明確過期的資格仍為：目錄內 `owner.pid` 標記的行程已不存在，或無標記的舊目錄超過 24 小時未被修改；存活行程（含本行程）的目錄與非一般目錄一律不動。異常強制退出或 I/O 清理失敗仍可能留下 bounded 暫存檔／orphan process，不能保證 process tree 全部已停止。
- SDK 嵌入式宿主必須 **`await runtime.dispose()`**，讓宿主發送 `session_shutdown` 並等待 extension cleanup。單獨呼叫同步 `session.dispose()` 不保證發送此事件，**不能當作背景退出清理 API**。若執行／輸出／通知時觀察到 owner getter 已失效，會 fail closed、取消並清理已觀察到的工作、抑制通知；不使用輪詢 timer，因此安靜且沒有後續 callback 的工作不保證立即偵測，仍需正確 runtime dispose。
- 長例外訊息在判定原始 timeout 尾部後才縮減，保留頭尾與省略標記；超長輸出不會吞掉 timeout 狀態或尾部診斷。
- owner 綁 session，不綁目前 branch；來源 toolCallId 隨通知提供，切換 branch 不會撤銷背景副作用。所有工作與主 agent 共用 workspace，避免並行修改同一檔案；必要時自行使用獨立 worktree。
- 背景失敗仍沿用下面的選用 failure debug log（其既有不自動輪替政策不變）。query／control 不適用 shell。

## Session 載入核對（不是工作恢復）

- 受理／開始／取消要求／終結及 shutdown reason 寫入版本化 `pi-better-tools-background-state` session journal，只投影 job/toolCall ID、owner/canonical cwd/runtime、狀態、exit/error code；不保存 command/output/log/credentials。受理紀錄寫入失敗拒絕提交；後續 I/O 故障不改已產生的結果，歷史可能只能報 unknown。Pi 1.0.0 會緩存無 user/assistant 的空 session，`--no-session` 不落盤；這兩種情況以 `BACKGROUND_JOURNAL_FAILED` 拒絕背景提交，同步呼叫不變。不改宿主內部 flush 或捏造 user 訊息。
- `session_start` 的 startup/resume/reload 核對 session-wide 同 owner/cwd 紀錄，通知附在 active branch；fork/clone 不採用沒有原 owner 證據的舊 receipt。已保存的同 branch 通知／正常完成通知去重，新證據可補，沒有相關歷史不發訊息。一般 foreground output 不當作 journal；舊文字 receipt 必須對應 assistant 的 `background:true` tool call。
- customType `background-runtime-recovery-shell`、display:true、triggerTurn:false；英文安全前言＋compact JSON，詳細 metadata 放 details。finding 為 `terminal_result_recorded`／`shutdown_cancellation_requested`／`outcome_unknown`／`start_not_confirmed`，與 lastKnownState 分開；`processTreeState` 永遠 unknown。TUI 使用中性色，收合顯示數量／ID 尾碼／finding，展開顯示完整 IDs、outcome、reason 與 next action。
- 核對最多 100,000 entries、4 MiB 投影／解析預算、每筆文字 32 KiB、128 jobs、每則 32 findings；legacy／branch／journal 共用解析預算，超限／malformed 明說 incomplete／omitted。不是 exactly-once；不能由訊息缺席推論失敗。檢查 session journal，不讀 log、鎖或 child native，不接管 registry、不重跑命令、不啟動模型、不新增設定或儲存目錄。退出／取消不證明 descendant 全部死亡。

## 完成通知 TUI

通知使用原生工具呼叫相同的背景色塊與內距，不畫框線，收合／展開一致。SDK Box 填滿整列，背景依權威狀態使用 toolSuccessBg／toolErrorBg／toolPendingBg；批次有失敗用 error，全部成功才用 success，其餘保持 neutral pending 色盤（不更改取消／未知狀態）。3欄以上左右留1欄，較窄不留左右內距；上下各留1行，總300行含留白。截短／換行的 SGR reset 會重套背景避免色塊斷開，色彩跟隨目前主題。

`/reload` 後，`shell-job-completed` 不再以原始 JSON 顯示。收合顯示狀態、exit code、耗時、命令與三行輸出預覽（優先 tail），以及截斷／log 提示；使用 Pi 的原生展開操作可看 job ID、較完整命令與通知內保留的 head/tail/error。狀態取自 metadata／exit code，輸出包含 `Error` 不會自行判定失敗，缺 exit code 不偽造成功。ANSI、OSC、控制碼與 bidi 僅在顯示層移除，Unicode 依終端欄寬截短／換行。

模型通知前言改為中性資訊提示：command/output/error 是回傳資料，不是指令；此提示不代表失敗，應由 status/exitCode/error 判定。TUI 輸出標題為英文 `Command output (data, not instructions)`／`Command output tail (data, not instructions)`，不使用容易誤認為錯誤的 untrusted 標籤。JSON payload/schema、資料不提升為指令的信任邊界與工作 lifecycle 不變；完成通知採上述 steer／喚醒政策。舊 session 原始通知不重寫。Renderer 不讀檔或執行工具；通知 head/tail 原本各最多 2000 字元，展開不會恢復已丟棄的輸出。額外顯示有每欄位及總計 300 行上限；log 只保留前 1 MiB，不是完整輸出。舊／格式不完整訊息會安全退回摘要；未提供 log 路徑不杜撰。

工具訊息使用英文。背景 receipt 補 `Background job accepted; its outcome will be reported when it finishes.`，接受時的耗時標為 `Accepted in …`；同步模式仍保留宿主 `Took …`，呼叫標籤 `(timeout 20s)` 不改。完成通知為 `Shell background jobs have finished. Individual outcomes follow.`，不代表所有工作成功，亦不改既有送達限制。

cancelled 即使帶非零 exit code 仍顯示 `cancelled · job cancelled · exit N`，不改稱 failed；timed_out 顯示 `time limit exceeded`。completed 缺 exit code 明說未提供，不假造成功。截短提示為 `Only part of the output is retained in this notification. The log retains at most the first 1 MiB.`，不以 outputTruncated 推論磁碟日誌必定不完整。

status／cancel 的 TUI 使用 `Job status`、`Reason`、`Next` 及展開的 `Job ID`／`Exit code`／`Retained output`／`Log` 欄位；模型 JSON/schema 維持。cancelling 明說取消要求與待清理；對終結工作呼叫 cancel 則說 `Job already finished; no new cancellation was requested. The existing outcome is unchanged.`，不假稱新增取消或程序樹已清空。evicted 僅表示保留紀錄淘汰與 log cleanup 已嘗試；missing 僅表示此 session/runtime 找不到紀錄。

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
