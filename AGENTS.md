# Pi Better Tools contributor guide

## 專案範圍

<!-- user-specified -->
- 使用繁體中文對話。
- 使用者另要求原生 `note` extension：`{ type, content }`，分類為 plan／design／issue／research／report／task，自動產生檔名、只新增檔案並回報路徑；後續交由檔案工具操作。檔名由系統自動產生（`TYPE-<UTC 時間戳>.md`，不附加標題或 slug，不接受使用者指定路徑），回傳單一相對路徑。
- 專案新產生的 ULID 一律使用 `ulid().toUpperCase()`；保留既有小寫 ULID／UUID 的讀取相容性，不改寫既有 ID。
- Script 長時間執行時定期輸出英文進度，不允許長期沉默。

## 結構與依賴

- 一個根 package、十七個本地模組：九個現存來源快照模組（Subagents／Shell／File／Web／SQLite／SQL Connector／PTY／第三方 Schedule Prompt／Blackhole），加上原生 Note／GPT Speed／重寫 JSON Schema／Pi Runtime／Monitor／Skill Tools／Fork／File Audit。根 `package.json` 的 `pi.extensions` 共十九個入口：十七個模組入口、npm `pi-open-tui` 入口，以及 `modules/file-tools/src/fff-override.mjs`（npm `@ff-labs/pi-fff` 的薄包裝，預設 override）；不建立新的 plugin manager。
- Node.js 需求以根 `package.json.engines` 為準，目前為 `^22.22.2 || ^24.15.0 || >=26.0.0`。原始碼掛載先在根目錄執行 `npm ci --ignore-scripts`；本機 Pi package 不會自動安裝依賴。Repository `.npmrc` 的 `legacy-peer-deps=true` 避免第三方 peer 自動安裝另一份 host SDK；不代表執行期相容性。Blackhole 整合測試必設 `PI_BLACKHOLE_PASSIVE=true`、隔離 credentials，不呼叫真實背景模型。三個套件設定仍由使用者管理，不在 install/reload 時改寫。
- 根目錄管理依賴與唯一 lockfile。模組 metadata 保留來源身份與測試命令，不是獨立安裝單元；不要在 `modules/` 執行 `npm install`。
- Pi、Pi AI、Agent Core、TUI 與 TypeBox 是 host-provided `peerDependencies: "*"`；不能放入 runtime dependencies 或 bundle。
- 不允許 runtime 依賴來源專案的絕對路徑、symlink 或 `node_modules`。
- 依使用者要求，十七個本地 Pi 入口統一為 `./modules/<name>/src/index.ts`，直接載入 TS；兩個 npm 第三方 extensions 從本專案 `node_modules` 載入，FFF 經上述薄包裝轉接，不改寫第三方實作。File Tools 不再註冊 `grep/find`，由 FFF override 提供；修改搜尋整合前讀 `modules/file-tools/README.md`。薄入口可轉接既有實作。目前沒有模組需要建置產物（`npm run build` 為 no-op）。保留 Subagent guard、bundled agents、prompts 及 File diff worker 的相對位置；入口 filters 遷移見 `docs/migration.md`。
- 記錄來源版本／雜湊與整合差異；匯入基準見 `docs/sources.json`，本地適配見 `docs/adaptations.json`；原生模組另記於 `docs/native-modules.json`。不要把快照更新偽裝成無差異複製。

## 行為與安全不變量

- 保留現有工具名稱、schema、設定鍵、儲存目錄與授權／trust 語意。不能以整合為由啟用未選的 tools。
- Skill Tools 透過 `resources_discover` 提供 `modules/skill-tools/skills/`，不在 runtime 複製至 home；停用必須排除 extension（`skills: []`／`--no-skills` 不抑制動態資源）。修改前讀 `modules/skill-tools/README.md`。`pi-tools-config` 及其 references 必須可整個目錄獨立搬移，只連結技能目錄內資源，不依賴 repository／模組 README 或 home 副本。
- 修改 File Audit 前讀 `modules/file-audit/README.md`：成功 read/write/edit/note 共用 run 窗口與記錄容量，note 路徑取成功結構化結果；手動增量檢查不取代全量 `sources:verify`，不自動刷新 provenance、不以缺紀錄／超限當通過，不讀完整歷史或注入模型 context。
- 修改 Fork 前讀 `modules/fork/README.md`：Fork 是獨立 Pi 行程（非 sandbox）；`fork`／`fork_status`／`fork_cancel` 預設啟用，仍遵守宿主 allowlist／exclusions／no-tools 與手動停用，managed child 不註冊；Fork 可用 `subagent` 但任何 Subagent 與 Fork 自身都不可建立 Fork（Subagent argument builder 排除、啟動握手、起源標記三層）；快照只在 turn_end 的 canonical 邊界取得、不捏造 tool result；結果只回報原 session、不在背景啟動 parent 模型；quit／reload 扇出取消全部、close 未確認不得宣稱已清理；不跨重啟重跑。管理 extension 必須每個 session 都載入，不以 monkey-patch 補洞。
- 修改 Monitor 前讀 `modules/monitor/README.md`：四來源唯 owner/canonical cwd/generation，readonly job adapter 不取消 job／query 模型；explicit managed child 不註冊且 execute 拒絕。WS 必須 DNS pin／TLS 驗證、private/insecure 分開 opt-in、禁 redirect/compression、pre-allocation payload cap；close/cancel/submitted 不等於 descendants cleanup／host ack，不跨 reload 重播。
- Shell `timeoutMs` 是自指令啟動起算的總時限（前景與背景相同，使用宿主絕對計時器，輸出不重置）；背景 job 未設 `timeoutMs` 時，若 `monitor_start` 已選取則經 rendezvous 自動啟動 `shell_job` Monitor（180 秒、`wakeAgent:false`、1800000 ms 期限，best effort，不啟用未選工具、不取消 job）；前景無 `timeoutMs` 指令滿 180 秒（`pi-shell-tools.autoBackgroundMs`，0 停用）自動由同一 process 轉為背景 job 作兜底，交接後 turn abort 不再停止、需 `shell_job_cancel`，Subagent 前景 child 不適用；保留宿主的取消、輸出與 shell settings。
- Deferred 工具（`exposure: "deferred"`）：模組只宣告 exposure／namespace；啟用 `tool_search`、無 `tool_search` 時的直接宣告與載入提示一律由 Pi Runtime 的 `deferred-tools.ts` 統一處理，不在各模組重複。這是不啟用未選 tools 的有意例外：僅對全新 session 啟用 `tool_search`，不改使用者 settings 檔，`--tools` allowlist 排除者不受影響。
- 修改 Subagents／Shell 前讀各模組 README。Subagent child 一律經既有 argument builder，保留 `--exclude-tools subagent`、32 submitted／8 active 上限、串流背壓與取消保障。Managed child 的 Shell 只提供前景 definition（`command`／`timeoutMs`），不註冊背景管理工具；身份依明確 guard handshake，不以 cwd／RPC／prompt 猜測。
- 背景通知、receipt、log 或 partial 結論不等於 runner 完成；須核對同一 job/task/invocation 的終態與退出證據。Session 載入時的 journal 核對只補歷史證據，不重建 registry、不重跑或續接工作；取消要求不代表整棵 process tree 已停止。
- 修改共用 prompt 注入前讀 `modules/pi-runtime/README.md` 與 `docs/architecture.md`。保留各自的 structured system prompt sections、工具選取條件及 custom／forced prompts，不整份覆蓋 system prompt；deferred discovery 與跨模組工具規則由 Pi Runtime 集中維護。Runtime recovery 保留每任務最多兩次及持久化 admission 證據鏈；cyber／policy／未知錯誤不自動恢復，manual recovery 須 idle TUI 確認，不改模型／工具權限或重播副作用。
- Web 保留公開 HTTP(S)、私有位址封鎖、lazy browser、shutdown cleanup，以及 OpenAI／Gemini 原生、Brave／Exa／DeepSeek REST 的模式區隔；不更動 Pi credentials（DeepSeek REST 只讀取 Pi 既有的 `deepseek` 登入憑證）。原生搜尋注入只對已知 provider／API 組合生效，不確定的一律不注入並警告；Anthropic 原生搜尋未實作（Pi 丟棄 server tool block）。修改前讀 `modules/web-tools/README.md`；Fetch 的 URL/DNS 檢查未釘住實際連線 IP，不能宣稱已根治 DNS rebinding 或是 SSRF sandbox。
- 修改 SQLite 前讀 `modules/sqlite-tools/README.md`：使用 `node:sqlite`，保留 `SQLITE_PATH` > trusted 專案 `.pi/agent/sqlite.json` > manual mode 的優先序；fixed mode 不註冊 open／close，設定錯誤不退回 manual；shutdown／reload 關閉連線。
- 修改 SQL Connector 前讀 `modules/sql-connector/README.md`：只從 trusted cwd 的 `.pi/agent/sql-connector.json` 載入，只註冊已配置的 `mysql`／`mssql`／`pgsql` deferred namespaces；每次寫入須互動 UI 確認，非互動拒絕，保留 SQL allowlist／bindings／結果上限與遮罩。連線設定與 credentials 不提交、不降級 TLS 或認證。MSSQL Windows Authentication 的 optional `msnodesqlv8`／ODBC 須明確安裝，不因缺少 binding 阻止其他功能載入，也不自動回退認證；離線測試不等於真實資料庫連線驗證。
- PTY target 預設 local，named WSL／SSH 設定遵循 Pi trust-aware settings；不回退 local、不停用 SSH host-key 驗證、不保存密碼、不自動 Git 同步。Windows node-pty kill 不支援 POSIX signal；關閉 transport 不代表遠端 process tree 已停止。修改前讀 `modules/pty-terminal/README.md`；ignore-scripts 安裝後明確 `npm run pty:install`。
- Schedule Prompt（第三方 tintinweb/pi-schedule-prompt，MIT，保留其 LICENSE，非使用者擁有）保留工具名 `schedule_prompt`、`/schedule-prompt`、`.pi/schedule-prompts*.json` 儲存與 session 綁定語意；它在 session 內行程執行排程 prompt／in-process subagent，不是 OS 排程或 sandbox，且不得與 Subagents 的 child 保障混為一談。本專案本地新增 shell command job（`command`／`shell`／`cwd`／`timeoutMs`，見 `modules/schedule-prompt/README.md`）：須在互動 session 確認確切指令、經 Monitor 的 Shell helper 在 session 內執行、不啟動模型也不喚醒 parent、輸出只進顯示用 marker；timeoutMs 是輸出停滯期限而非總時限；專案外目錄只在本行程核准後執行且核准不持久化；它不是 sandbox。前一個已移除的 Scheduler（`schedule_*`、`/schedule`、`pi-scheduler`）不得復活。
- Blackhole 0.5.12 快照位於 `modules/blackhole/`，入口 `src/index.ts` 轉接原 factory；保留上游 MIT LICENSE、設定與原生 compaction 行為。修改前讀 `modules/blackhole/README.md`；只替換 Pi 已啟動的原生摘要，timing／preparation／cut／tail／persist／retry／cancel 仍歸 Pi，不復活舊 timing/cut controls。顯示副本 selector 必須依 Pi `getBranch()` 的 oldest-first 順序往回掃描，只保存真的被切掉的最新 assistant 文字，不加入模型 context。修改通知 evidence／recall 前另讀 `modules/blackhole/docs/recall.md`；只投影 allowlisted 持久化證據，不提升為指令、不重播未知結果工作。新增問題修正先寫符合真實 host shape 的回歸測試、確認 red，再實作及確認 green；不還原修正前程式來製造 red。不自動回填既有壓縮 session。
- 不變更使用者真實全域 settings／auth／排程資料；測試使用隔離 home、agentDir 與 workspace。不呼叫付費模型或真實 provider credentials。
- 不宣稱 process isolation 是 OS sandbox，或取消要求等於 process tree 已停止。
- 使用者已確認原五個來源專案及 pi-pty-terminal／pi-sqlite-tools／pi-sql-connector 為其所有，並要求本專案採 MIT；保留原有模組 copyright／LICENSE 與相依套件的個別授權，不把相依套件重新授權為 MIT。維持 `private: true` 防止誤發布 npm；GitHub／npm 遠端發布仍需另行明確授權。

## 驗證與交付

- 先讀取欲修改模組的 `AGENTS.md`／README；其舊版依賴、獨立 lockfile 與 scripts 宣告是匯入時的歷史資訊，整合版本／命令以根 manifest 為準。未匯入的來源報告位置見 `docs/source-references.md`。
- 專案只支援 Pi 1.3.0：開發基準與 production smoke 都只驗證 1.3.0，不再維護 1.2.0 或更早版本的相容驗證。模組匯入時的版本不是目前基準；不以 wildcard peers 宣稱其他版本相容。
- 驗證命令與分組以根 `package.json`、`scripts/run-checks.mjs` 為準；純文件修改核對事實、命令及引用路徑，不必執行程式測試。`npm run build` 目前為 no-op，不代表型別或 runtime 驗證。
- 測試依變更範圍分組，不要每次都跑全部：
  - `npm test`（單元）：每次修改程式碼後的基本檢查；`npm run typecheck`：修改 TS 型別、介面或 schema 時。JS／TS 修改另執行 `npm run lint`（correctness baseline，不自動 `--fix`，不等於安全審查）。
  - `npm run test:module -- <module>`（該模組的 build／typecheck／單元／整合／真實 host 測試；module 為 blackhole、file-audit、file-tools、fork、gpt-speed、json-schema、monitor、note-tools、pi-runtime、pty-terminal、schedule-prompt、shell-tools、skill-tools、sql-connector、sqlite-tools、subagents、web-tools；blackhole、schedule-prompt 與 sql-connector 保留 Vitest runner）：只修改該模組時執行，不跑其他模組的整合測試。Web 真實瀏覽器測試包含在 `test:module -- web-tools`，需先 `npm run browser:install`。
  - `npm run test:cross`（所有 manifest extensions 載入、SDK hooks、provenance）：修改根 `package.json`／manifest、`scripts/`、`tests/`、共用 helper、`docs/*.json` provenance、Pi 版本，或同時變更多個模組時。
  - `npm run test:integration`（全部整合）、`npm run test:package`、`npm run check`：只在發布前、升級 Pi／依賴、變更 package `files`／入口／tarball 內容，或使用者明確要求完整驗證時執行。
  - 交付說明須列出實際執行的分組與理由；未執行的分組要明講為未執行，不算通過。
- 變更匯入來源／本地適配／原生模組 provenance 時執行 `npm run sources:verify`；當前雜湊完整性通過不等於歷史差異等價，保留既有 historical delta unavailable 記錄。
- Cross／production smoke 需要可執行的 ripgrep：由 PATH 提供 `rg` 或設定測試專用 `PI_BETTER_TOOLS_TEST_RG`，不下載 binary 或修改個人設定；缺少時明確失敗，不 skip 斷言。`test:package` 需要 npm registry。Web 真實瀏覽器測試需先 `npm run browser:install`；Linux 系統依賴見根 README，執行會修改系統套件的 `setup:browser`／`browser:install-deps` 前須取得同意。
- 新增測試前先判斷分組：不依賴真實 Pi host、子行程或固定等待的放單元測試；需要真實 host／CLI／瀏覽器者放整合測試並歸屬單一模組。不新增靠 idle、watchdog 或固定 sleep 驗證 timeout 的測試（`timeoutMs` 語意已穩定，由 `timeout-ms.test.mjs` 單元測試覆蓋）。
- 保留來源測試 runner；路徑／版本適配不能弱化斷言或默默跳過已支援 host 的 probes。Subagents `hostContract: "0.99.1"` 是持久化格式身份，不隨 SDK 升級更名。實際 tarball 必須驗證乾淨 production dependencies、Pi loader、worker、guard、agents、prompts 與 runner。
- Skip、環境阻礙及未執行不算通過。進度、證據、剩餘風險保存在 `plan/`，不要放入本文件。
- 變更功能／設定／路徑時同步更新 README、相關 `docs/` 與 provenance；交付時說明實際驗證、失敗與未完成項目。
