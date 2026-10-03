# Pi Better Tools contributor guide

## 專案範圍

<!-- user-specified -->
- 使用繁體中文對話。
- 使用者另要求原生 `note` extension：`{ type, content }`，分類為 plan／issue／research／report／task，自動產生檔名、只新增檔案並回報路徑；後續交由檔案工具操作。
- Script 長時間執行時定期輸出英文進度，不允許長期沉默。

## 結構與依賴

- 一個根 package、六個現存來源快照模組（含 PTY）與原生 Note／GPT Speed／Goal／重寫 JSON Schema；Pi manifest 直接列出十個入口，不建立新的 plugin manager。
- 根目錄管理依賴與唯一 lockfile。模組 metadata 保留來源身份與測試命令，不是獨立安裝單元；不要在 `modules/` 執行 `npm install`。
- Pi、Pi AI、Agent Core、TUI 與 TypeBox 是 host-provided `peerDependencies: "*"`；不能放入 runtime dependencies 或 bundle。
- 不允許 runtime 依賴來源專案的絕對路徑、symlink 或 `node_modules`。
- 依使用者要求，所有 Pi 公開入口統一為 `./modules/<name>/src/index.ts`，直接載入 TS；薄入口可轉接既有實作。Scheduler 只有獨立 CLI 保留 TS → `modules/scheduler/dist` 建置。保留 Subagent guard、bundled agents、prompts 及 File diff worker 的相對位置；入口 filters 遷移見 `docs/migration.md`。
- 記錄來源版本／雜湊與整合差異；匯入基準見 `docs/sources.json`，本地適配見 `docs/adaptations.json`；原生模組另記於 `docs/native-modules.json`。不要把快照更新偽裝成無差異複製。

## 行為與安全不變量

- 保留現有工具名稱、schema、設定鍵、儲存目錄與授權／trust 語意。不能以整合為由啟用未選的 tools。
- Shell `timeoutMs` 是輸出停滯期限，不是總執行時間；保留宿主的取消、輸出與 shell settings。
- Subagent child 一律經既有 argument builder，保留 `--exclude-tools subagent`、32 submitted／8 active 上限、串流背壓與取消保障。
- Web 保留公開 HTTP(S)、私有位址封鎖、lazy browser、shutdown cleanup，以及 OpenAI／Brave／Exa 模式區隔；不更動 Pi credentials。
- PTY target 預設 local，named WSL／SSH 設定遵循 Pi trust-aware settings；不回退 local、不停用 SSH host-key 驗證、不保存密碼、不自動 Git 同步。Windows node-pty kill 不支援 POSIX signal；關閉 transport 不代表遠端 process tree 已停止。修改前讀 `modules/pty-terminal/README.md`；ignore-scripts 安裝後明確 `npm run pty:install`。
- Scheduler 不安裝 OS service；保留 app-open-only、missed-no-backfill、revision／claim、orphan barriers、profile restoration、reserved marker 與 `PI_SCHEDULER_CHILD`。
- 不變更使用者真實全域 settings／auth／排程資料；測試使用隔離 home、agentDir 與 workspace。不呼叫付費模型或真實 provider credentials。
- 不宣稱 process isolation 是 OS sandbox、取消要求等於 process tree 已停止，或排程為 exactly-once。
- 使用者已確認原五個來源專案及 pi-pty-terminal 為其所有，並要求本專案採 MIT；保留原有模組 copyright／LICENSE 與相依套件的個別授權，不把相依套件重新授權為 MIT。維持 `private: true` 防止誤發布 npm；GitHub／npm 遠端發布仍需另行明確授權。

## 驗證與交付

- 先讀取欲修改模組的 `AGENTS.md`／README；其舊版依賴、獨立 lockfile 與 scripts 宣告是匯入時的歷史資訊，整合版本／命令以根 manifest 為準。未匯入的來源報告位置見 `docs/source-references.md`。
- 根開發基準固定 Pi 1.0.0；production smoke matrix 保留 0.99.1／0.99.2／1.0.0。模組匯入時的版本不是目前基準；不以 wildcard peers 宣稱所有版本相容。
- 整合 scripts 建立後，執行 `npm run build`、`npm run typecheck`、`npm test`、`npm run test:integration` 與 `npm run test:package`；涉及 Web 實際瀏覽器時另執行 `npm run browser:install`、`npm run test:browser`。
- 測試依變更範圍分組，不要每次都跑全部：
  - `npm test`（單元，約 2 分鐘）：每次修改程式碼後的基本檢查；`npm run typecheck`：修改 TS 型別、介面或 schema 時。
  - `npm run test:module -- <module>`（該模組的 build／typecheck／單元／整合／真實 host 測試；module 為 file-tools、goal、gpt-speed、json-schema、note-tools、pty-terminal、scheduler、shell-tools、subagents、web-tools）：只修改該模組時執行，不跑其他模組的整合測試。Web 真實瀏覽器測試包含在 `test:module -- web-tools`，需先 `npm run browser:install`。
  - `npm run test:cross`（所有 manifest extensions 載入、SDK hooks、provenance）：修改根 `package.json`／manifest、`scripts/`、`tests/`、共用 helper、`docs/*.json` provenance、Pi 版本，或同時變更多個模組時。
  - `npm run test:integration`（全部整合）、`npm run test:package`、`npm run test:matrix`、`npm run check`：只在發布前、升級 Pi／依賴、變更 package `files`／入口／tarball 內容，或使用者明確要求完整驗證時執行。
  - 交付說明須列出實際執行的分組與理由；未執行的分組要明講為未執行，不算通過。
- 新增測試前先判斷分組：不依賴真實 Pi host、子行程或固定等待的放單元測試；需要真實 host／CLI／瀏覽器者放整合測試並歸屬單一模組。不新增靠 idle、watchdog 或固定 sleep 驗證 timeout 的測試（`timeoutMs` 語意已穩定，由 `timeout-ms.test.mjs` 單元測試覆蓋）。
- 保留來源測試 runner；路徑／版本適配不能弱化斷言或默默跳過已支援 host 的 probes。Subagents `hostContract: "0.99.1"` 是持久化格式身份，不隨 SDK 升級更名。實際 tarball 必須驗證乾淨 production dependencies、Pi loader、worker、guard、agents、prompts 與 runner。
- Skip、環境阻礙及未執行不算通過。進度、證據、剩餘風險保存在 `plan/`，不要放入本文件。
- 變更功能／設定／路徑時同步更新 README、相關 `docs/` 與 provenance；交付時說明實際驗證、失敗與未完成項目。
