# JSON Schema checklist 修補與回歸驗證（M8／M9／L32／L33）

- 日期：2026-10-08。
- 授權修改範圍：僅 `modules/json-schema/**`；本報告依要求由原生 `note` 建立。
- 基準：`C:/Users/KY6584/AppData/Local/Temp/pi-better-review-baseline.json`。初始 read 的 SHA-256 與該基準一致；不把任務開始前的修補算成本次新修。
- 已讀：`report/code-review-checklist.md`、模組 README、software-fix-bugs 與 test-case-creator skills、Pi 1.0.0 `docs/extensions.md` 全文。模組內沒有額外 AGENTS.md。宿主 `agent-loop.js` 確認 agent_end 傳入本輪 newMessages；公開工具、旗標、schema、trust 與 host API 契約不變。

## 逐 ID 狀態

### M8 — 已有初步修補；本次補強並驗證

初始程式已在 message_end 保存 lastText，agent_end 再附回最後一則 assistant。舊 checklist 的「完全沒有回填」描述已過時；但該方式只保存最後一則、將多個 text 區塊合併，而且宿主傳回原始訊息時會重複追加文字。

本次改為保存每一則被抑制的 assistant 原始 content 區塊，在 agent_end 依訊息順序以完整原始 content 替換副本，避免重複文字及區塊重排；不修改宿主 event.messages。stdout 抑制維持原行為。`suppressedContent` 在 input／agent_end 清空。

回歸覆蓋：宿主傳入原訊息／replacement 兩種情況；多則 assistant、多個 text 區塊、Unicode；抽取 prompt 每段原文恰好出現一次且順序正確；宿主訊息本身保持不變。

### M9 — 任務前已修復；本次增加回歸並同步 README

初始 `src/extract.ts` 已有 extractJsonCandidates，recover 的本地及抽取文字路徑也已逐候選驗證。因此本次沒有修改 extract.ts 或宣稱新增候選迭代。

新回歸確認 `{}`、`[1]`、型別錯誤物件不阻擋後續有效值；有兩個有效值時採用第一個，不取最後一個。本地回收的測試將 activeTools 設為空並以 assert.fail 阻止任何抽取呼叫；抽取回應案例只使用 stub complete，先略過無效 fenced JSON／陣列再取第一個有效物件。候選偏好仍是整段、fenced blocks、brace scans，原 64 次／1,000,000 字元扫描限制不變。

### L32 — 排隊部分已存在；本次完成重用及生命週期防護

初始程式已限制 4 個活動 worker、256 件等候，並非仍然「第五件直接失敗」；尚存的問題是每次驗證都新建 worker、重載 zod、重編 schema。

新增 `ValidationPool`：最多 4 個 worker、FIFO 等候最多 256 件；排隊取消會移除 waiter；容量超限明確失敗。持久 worker 載入 zod 一次，每個 worker 只快取最後一個 schema validator，換 schema 不沿用錯誤驗證器。ready handshake 的啟動／載入上限為 10 秒；ready 後每件工作仍有 2 秒期限（含 schema 編譯），排隊時間不消耗驗證期限。沒有調高原本的驗證工作期限或放寬任何成功斷言。

取消／故障／逾時將 worker 標為 retiring、忽略 late message，確認 terminate／exit 才釋放 slot。terminate 拒絕時仍保留容量，直到 late exit；驗證回報失敗而不是交付資料。閒置 worker unref，30 秒後回收；既有 session_shutdown 的 finally 會 close pool，排空 queued 工作並等待終止；close 可重入，完成後下一 session 可再次使用。

安全稽核、保守線性 pattern 子集、enum／const sibling 防護、本地 refs 與 draft-07 tuple 稽核都未改動。無 pattern 的同步路徑保留。

新增回歸：重用同一 worker；不同 schema 切換；FIFO／260 件總容量與 overflow；queued abort；活動 abort 在 exit 前不釋放 permit；late message；shutdown drain 與下個 session；constructor failure、worker error、unexpected exit、terminate failure／late exit。真實 worker 案例確認 serial jobs 只建立一個 worker、close 後 threadId=-1。新增真實 Pi CLI patterned schema＋parallel duplicate tools 案例，證實 jiti source loader 能找到新 pool／worker，模型只呼叫一次且 shutdown handlers 正常執行。

### L33 — 任務前已修復；本次加入可控故障回歸

初始 delivery.ts 已有 renameWithRetry：EPERM／EBUSY／EACCES，最多 8 次 retry，backoff 為 20／40／60／80／120／200／300／500ms，合計 1.32 秒。本次保留 production rename 行為，將 helper export 並提供內部 operations 注入點，便於不依賴真實 Windows 鎖定／固定等待的故障測試。

回歸確認三種 transient code 成功重試、精確 backoff、永久鎖定九次 attempt 後保留原 error、ENOENT／EXDEV／無 code 不重試。既有原子替換、失敗保留舊檔、清理 temp 的測試維持原斷言。

## 相對 dispatch baseline 的檔案異動

### 修改（8 個）

- `modules/json-schema/README.md`：候選選擇、原文 transcript、rename backoff、pool／queue／deadline／cleanup 契約。
- `modules/json-schema/extensions/json-schema.ts`：逐則原始 content 回填；session_shutdown finally close pool。
- `modules/json-schema/src/schema.ts`：pattern 驗證轉交共享 bounded pool；原稽核與同步驗證不變。
- `modules/json-schema/src/delivery.ts`：export renameWithRetry 與 operations 注入；production retry 策略不變。
- `modules/json-schema/src/validation-worker.mjs`：persistent ready／postMessage protocol、last-schema validator cache。
- `modules/json-schema/tests/delivery.test.ts`：rename transient／exhaustion／non-transient regressions。
- `modules/json-schema/tests/workers.integration.test.mjs`：真實 worker reuse／cache／confirmed shutdown；after cleanup。
- `modules/json-schema/tests/runtime.test.mjs`：新增真實 Pi patterned-schema parallel tools／shutdown 回歸；原完整 CLI probe 斷言不變。

### 新增（3 個程式／測試檔）

- `modules/json-schema/src/validation-pool.ts`：ValidationPool、validationPool、bounded queue／lifecycle。
- `modules/json-schema/tests/recovery.test.ts`：M8／M9 stubbed fallback 與 extraction-disabled 本地回收。
- `modules/json-schema/tests/validation-pool.test.ts`：事件協調的 deterministic pool regressions，不靠固定 sleep。

### 新增驗證紀錄（3 個）

- `modules/json-schema/tests/review-module.log`：首輪完整紀錄（3/4 stages，CLI loader-cache 暫時錯誤）。
- `modules/json-schema/tests/review-module-rerun.log`：原樣重跑 4/4 stages passed。
- `modules/json-schema/tests/review-module-final.log`：最後版本（包含新增真實 patterned host 案例）4/4 stages passed。

所有模組檔案已檢查 LF；三份 log 以 UTF-8／LF 寫入。

## 實際驗證與首輪失敗

1. 聚焦 `tsc -p modules/json-schema/tsconfig.json` 通過；初次聚焦 unit run 14/14 passed，無 skip。
2. 第一輪 `npm run test:module -- json-schema`：typecheck、34 unit、5 worker integration passed；real CLI failed。證據顯示 file-tools extension 的共用 jiti 暫存檔 `src-file-operations.b67e217b.mjs` 出現 Windows `UNKNOWN: unknown error, open`，stdout text case 的原始 exit-code 斷言正確失敗。保留紀錄，不算通過。
3. 原樣第二輪同命令：4/4 stages passed。未放寬 assertion、未減少 CLI 原有四案例並行、未更動快取設定。
4. 新增真實 patterned host 回歸後，最後再跑同命令：4/4 stages passed；34 unit、5 worker integration、2 real-host test cases 全部通過，無 skip／cancelled。完整 CLI probe 的 31 個 scenarios 均 passed，hostVersion=1.0.0、noNetwork=true、noPaidModels=true；另一個 host test 覆蓋 patterned parallel tools。
5. 最後模組所有檔案 LF 檢查通過。

runner 自動產生的根 evidence 為 `plan/evidence/module-json-schema.json` 及 json-schema 各 stage logs；本次未手動修改根 scripts／tests／docs／checklist／provenance。

因為是單一模組修補，未執行全專案 npm test、test:cross、完整 test:integration、test:package、check 或獨立 build；不宣稱它們通過。分組 runner 已執行本模組 typecheck／unit／worker／real-host 四階段。

## 剩餘風險與父 agent 精確接續動作

- 父 agent 已發現根 package-smoke 的舊 workerData＋natural-exit／單一訊息 probe 與 persistent worker protocol 不相容，並表示會修改。需在父 agent 範圍調整為 ready handshake、postMessage、confirmed terminate，將 `validation-pool.ts` 加入必要來源檔，然後執行 package 驗證；本次未修改該根 script，也尚未驗證 tarball。
- 父 agent 已發現任務前 51 個 provenance mismatches；由父 agent 統一處理。本次不更新根 provenance，避免越權或把既有 mismatch 算成新修。
- 父 agent 可更新 checklist：M8 標為已有初修後補強；M9、L33 標為任務前已修復＋新增回歸；L32 標為排隊已有／worker reuse 本次完成。不得將本次所有四項描述為首次修復。
- Pool 是 worker thread 計算隔離，不是 OS sandbox。terminate 異常時採 fail-closed 保留 slot，極端情況可能降低容量直到真實 exit；不宣稱取消要求即代表 worker 已停止。
- 一般 unit stub 測試只呼叫本地 fake complete；真實 CLI 使用禁止 fetch 的 synthetic provider／隔離 home，未使用真實 credentials、network 或 paid extraction。
- Windows 共用 jiti cache 的首輪 I/O 暫時失敗仍屬整合環境風險；保留首輪失敗紀錄，成功重跑不能抹除該事件。
