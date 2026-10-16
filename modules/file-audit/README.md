# File Audit

原生 Pi 1.3.0 extension。追蹤本 session 成功的 `read`／`write`／`edit`／`note`，提供有界限、唯讀的近期 provenance 增量檢查，不取代 `npm run sources:verify`。

## 載入與拆裝

根 manifest 入口為 `./modules/file-audit/src/index.ts`。亦可單獨試用：

```powershell
pi --no-extensions -e ./modules/file-audit/src/index.ts
```

以既有 package extension filters 排除 `modules/file-audit/src/index.ts` 即可停用；工具 allowlist 不會停用 slash commands。本模組不註冊模型工具、不啟用其他工具、不修改其輸入／結果／prompt；無額外 runtime dependency，不 runtime import File Tools 或 Note Tools。沒有額外安裝、全域設定、模型驗證、watcher、背景工作或持久化活動日誌。

## 指令

| 指令 | 行為 |
| --- | --- |
| `/file-audit`、`/file-audit status` | 顯示窗口、容量、觀察起點、近期檔案及淘汰／略過次數，不讀候選內容或 provenance |
| `/file-audit check` | 固定當下候選快照，最近活動優先檢查；同時只准一個 check，不排隊 |
| `/file-audit clear` | 清空紀錄／統計、撤銷舊檢查，保留目前 limits |
| `/file-audit limits --window 4 --max-files 50` | 只調整本 session 限制；可省略其中一個值，縮限立即淘汰，非法參數不部分套用 |

只在 TUI 執行手動命令；RPC／JSON／print 不掃描、不寫 stdout、不要求對話。事件追蹤不依賴 UI。顯示使用宿主通知，不新增 widget 或模型 context 訊息，不保存報告。路徑清除終端控制字元與 bidi 控制碼，最多 10 筆明細、每條路徑 200 字元、總輸出 8 KiB，未顯示數明列。

## 窗口及成功證據

- 預設 4 runs／50 個不同檔案；可設 1–30 runs／1–500 files，0 不代表無限。run 為 `before_agent_start`（user/custom 均計入），不是每次模型／工具往返或真人輪數。
- 容量在每次納入時生效；相同檔案重新存取會更新最後活動順序。舊項目真正刪除，不是只截斷顯示。每個檔案只保留最近 read／write／note 分類所需的 run，不保存完整事件陣列。
- `tool_execution_start`／`tool_execution_end` 配對；僅確實執行且成功完成才納入，包含 nested read/write/edit/note。最多 128 筆 pending，只保存 ID、工具名、路徑／cwd 與 owner/generation/run，不保留 content/oldText/newText。路徑上限 4096 UTF-8 bytes，ID 上限 1024 bytes。
- `note` 屬新增寫入。實際路徑取成功結果的 `structuredContent.relativePath`／`details.relativePath`（同時存在須一致）；不猜檔名、不解析正文、不保存 `note.content`。後續 read/edit 同檔案共用名額，窗口內新增證據仍保留。
- 相對／絕對、`~`、file URL、`@` literal 優先與 Windows shell drive 路徑遵循 File Tools 的既有語意；已存在檔案用 realpath 去重，不一律 lowercase。
- session start（含 reload/new/resume/fork）、tree navigation、shutdown 清空觀察並撤銷舊結果；start 恢復預設 limits，tree 保留目前 limits。不讀完整歷史、不跨 session 恢復。觀察起點始終顯示。
- Shell／grep/find／其他 session／其他工具不納入。部分 read 不是完整審閱；成功 edit/write 不保證 bytes 必然改變。淘汰／略過計數是事件次數，不是精確的歷史不同檔案數。

## 增量檢查

只讀使用者目前 cwd 下三份檔案：`docs/sources.json`、`docs/adaptations.json`、`docs/native-modules.json`，不猜祖先根、不掃目錄、不讀原來源 sourcePath、不檢查 node_modules，也不呼叫全量驗證器。

有效 imports/adaptations、addedFiles、removedFiles、native files、final rootFiles 參與比較，歷史說明中的 hashes 不作現值。來源覆寫須與 originalSha256 相符且有理由；historical delta unavailable 保留審查限制。衝突／非法／缺失 metadata 均不假裝已驗證。

| 限制 | 上限 |
| --- | --- |
| 三份 metadata 實際讀取合計 | 8 MiB |
| 有效 inventory 處理項目（含 module 容器） | 50,000 |
| 每個候選內容 | 8 MiB |
| 一次候選內容總讀取 | 32 MiB |
| 同時檢查 | 1，循序串流 |

只有獲准候選才讀內容並計算 SHA-256；沒有 provenance 的新 note 等檔案列為 `untracked`，不自動登錄、不讀其全文。一般檔案的實際 realpath 必須位於 canonical cwd；已知 `.env`／`.env.*`、`auth.json`、`.git`／`.pi` 路徑不做內容掃描。預算控制實際讀取量，不是讀完再丟棄。沒有 metadata 的獨立專案／production package 仍能追蹤活動，但 check 明確 unavailable。

結果區分 `matched`、`mismatch`、`expected-absent`、`missing`、`untracked`、`skipped`、`unavailable`。未檢查／取消／超限／零候選不是通過；總結始終註明 recent incremental inspection, NOT full-project verification。

檔案 handle 前後身分／size／mtime／ctime 與路徑重驗只能觀察變動，不提供原子快照或 OS sandbox。取消只撤銷本次使用與晚到顯示，已開始 OS I/O 不一定立即停止；finally 關閉 handle。同窗口其他程式寫入仍可能造成不符，不推論作者或引入時間，也不宣稱 hash 一致代表歷史 diff 等價。

## 驗證

```powershell
npm run test:module -- file-audit
```

包括 strict typecheck、容量／窗口／排序、note 結構化路徑、成功事件、掃描 bytes 與錯誤、命令／輸出邊界，以及隔離 home/agentDir/cwd 的真實 Pi 1.3.0 native/File Tools/Note/nested/reload/tree/new/resume／獨立載入／不載入 probes。SDK fixture 的 TUI 通知 callback 由測試擷取；另有下述真正 PTY TUI A/B，兩者不是同一項驗證。只使用離線合成 provider，`providerCalls` 指實際外部 fetch 次數，`streamCalls` 另記合成模型串流次數。根 cross／production smoke 另驗證 manifest 共存與乾淨 tarball 載入。

### 真實 TUI A/B 與 token overhead

```powershell
node --test modules/file-audit/tests/tui-ab.integration.test.mjs
```

測試使用 `node-pty` 啟動真正 CLI（需先安裝 PTY native binding，見根 README 的 `pty:install`），不是 print/RPC 或假 UI。regular A→B、fullscreen B→A 各用獨立 home/agentDir/cwd；A 明確不載入本 extension、B 明確 `-e` 載入，其餘工具相同。以 PTY 輸入 prompt、`/file-audit` 與測試觀察命令；保留真正通知與畫面，驗證 note、失敗 read 排除、去重、已植入 provenance mismatch、容量與窗口。

兩組各執行12個相同的合成模型請求，驗證手動 status/check 不觸發額外模型請求、後續 context 無報告污染、工具宣告不增加。Pi 1.3.0 prompt/tool deltas 由 system messages 的公開 helpers 還原，經 onPayload hook 後記錄；未修改 transcript 另存。比較語意 payload 時只正規化隔離根路徑與自動產生的 note UTC 檔名，不移除 Audit 訊息。這能驗證 context overhead，不證明真人收尾時間改善或真實模型解題品質。

預設不安裝 tokenizer，token estimate 欄位為 null，不冒充已量測。若要重算估值，可在**另一個暫存目錄**以停用 scripts 的 npm 安裝 `js-tiktoken@1.0.21`，然後在測試行程設定：

```powershell
$env:FILE_AUDIT_AB_TOKENIZER = '<temporary-directory>/node_modules/js-tiktoken/dist/index.js'
$env:PI_BETTER_TOOLS_EVIDENCE_SCOPE = 'file-audit-ab-local'
node --test modules/file-audit/tests/tui-ab.integration.test.mjs
```

tokenizer 會驗證套件版本並使用 `o200k_base`，分列原始／正規化序列化語意 payload 的估計 tokens；不是實際 provider 的輸入 framing、cache 或帳單 usage，也不採計合成 usage。設定 evidence scope 時，journal（含全量隔離 transcript）、PTY raw output、每請求 bytes/hash/token estimates 與 summary 存在 `plan/evidence/<scope>/tui-ab/`；這個詳細記錄只屬測試 fixture，不是產品持久化功能。所有 owned CLI 須退出0才算成功並刪除工作目錄；失敗保留暫存證據位置，不宣稱整棵程序樹已清理。

### 讀後外部覆寫與交付關卡 A/B/C

```powershell
node --test modules/file-audit/tests/tui-workflow.integration.test.mjs
```

真正 fullscreen PTY 分三情境（clean、late-overwrite、evicted）跑 A/B/C 共9個隔離 CLI。父測試程序在成功 read config 後、下一個 prompt 前覆寫檔案，保存父／Pi PID、hash、metadata未變與事件時間線。feature 由真實工具修改並在 Node 子行程跑只斷言 answer=2 的測試；獨立 oracle 另以新 Node 程序驗證產物 answer=2 且 rollout=true，故可確認外部 config=false 形成真實需求失敗，不只是 hash 不符。

- A 不掛載，只依定向測試作交付決策；B 掛載，操作者手動執行 status/check；C 不掛載，在相同合成 workspace 透過測試專用命令執行**未修改的** `scripts/verify-sources.mjs`。
- C 使用完整有效的最小 provenance／離線套件身份 fixture，沒有安裝假套件或呼叫 registry。內容 inventory 是 config、feature 與64個16KiB無關檔；preload只計數真實 readFile，不改資料、hash或驗證斷言。config刻意放最後，fail-fast能觀察到66檔讀取；這不是正式 repository 的完整驗證或通用效能比較。
- 正常案例三組可完成；讀後覆寫時 A 的定向測試仍通過但產物錯誤，B/C能提供 config 診斷；模擬操作者依可見診斷修復config後，重查與獨立runtime oracle均須通過。已核准feature的正常provenance收尾三組一致，從不把config異常補簽成通過。
- evicted 把B容量設1，config被後續feature活動淘汰；check只能得到feature matched，**不能發現已淘汰檔案的異常**。實驗的操作者政策因缺少必查config而標成 review-incomplete，C仍能找到問題。

`blocked`／`review-incomplete` 是測試明示的**操作者政策**，不是extension自動阻擋；外部修復也不是產品或模型自動修復。provider固定相同操作，不能用此實驗推論真實模型自主能力、真人錯誤率或節省時間。各arm7次合成請求，手動關卡不加請求，後續payload不得含報告；可沿用上述tokenizer/evidence環境變數。證據存 `plan/evidence/<scope>/workflow/`，含真正PTY輸出、完整隔離transcript、初次及修復後結果、獨立oracle、實測I/O與時間線。
