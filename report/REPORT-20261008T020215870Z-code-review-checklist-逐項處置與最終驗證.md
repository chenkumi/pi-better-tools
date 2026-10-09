# Code review checklist 逐項處置與最終驗證

日期：2026-10-08。工作目錄：`D:/GitHub/pi-better-tools-main`。

## 後續現況更正（M4已完成修復）

M4曾因第二個reliability reviewer提出close-rejection ownership缺口而重新開啟，當時37完成／6部分；後續已補rejecting close barrier、normal／write-failure／late／late-create故障注入與lock retention。2026-10-08第一階段current-source独立查證確認本段追蹤過期，現恢復38完成／5部分／5政策待決／5保留。見 `issue/ISSUE-20261008T020740472Z-subagents-m4-重新開啟-transcript-close-失敗被誤視.md` 及 `report/REPORT-20261008T075605060Z.md`。

後續選定驗證來源：`report/REPORT-20261008T065714430Z-subagent-建立-訊息統一實作與最終驗證.md`（Subagents 299 unit／49 integration、cross 3/3、production package 19/19）；本輪第一階段新碼尚在進行，並未完成新驗證。以下原始測試／tarball／provenance仍是當時快照，不以後續修復倒算它已覆蓋close-rejection。另一笔EPERM／ENOTEMPTY清理問題、歷史RPC根因及通知缺漏仍分開追蹤，未因M4更正而關閉。

## 原快照結論

`report/code-review-checklist.md` 現存53項均已有逐ID處置：38項修復／既有修補查證、5項部分修復、5項政策待決、5項有理由保留。38項勾選，15項未勾選；未將既有修補冒充本次新增、未將部分緩解或政策保留誤稱根治。

## 本次主要補強

- Subagents：晚到I/O actual-idle、child close、spool iterator return與writer close後補block/release；跨loader process-wide live nonce。保留8 active permits、32 submitted、child argument builder及exclude-tools subagent、trust/schema/storage格式。
- File：每次edit lazy reusable RegexSession並在finally確認termination；rename retry保留完整hash/stat/cancel；deep/cyclic/string payload、rangePreview與regex錯誤診斷redaction。
- Web：extraction worker listener/ref/unref、pre-transfer byte check；6個active/idle/retiring共同容量、退出才釋ownership、shutdown等待全部owned workers。DNS peer檢查是事後緩解，不能防blind SSRF。
- Schedule：once fire=false明確error停用、不重送；100ms widget節流；owner-token locked mutation/corruption reread，不age takeover／無鎖fallback；有效session才reset。
- PTY：failed-match 50ms debounce，deadline不再spawn；worker ready後計compute budget；滿載只回收已讀exited sessions，保留unread/drop；exited pause不配置timer。
- JSON：原始assistant blocks精確回填；4-worker/256-queue validation pool、FIFO/cancel/startup/job budgets、last-schema cache與確認退出後釋容量。
- Note/GPT：relativePath-only text/details/structuredContent/schema與64Ki heading-discovery budget；GPT settings realpath target、鎖內permissions、dangling link／EACCES fail closed。
- Shell／空測試清單：既有cleanup/startup documentation/empty-list guard讀碼與實際測試確認，不重複改寫。
- Root README/configuration、Note loader/renderer fixtures與PTY/JSON/Web production worker probes同步。

## 實際驗證

| 分組 | 最終結果 | 選擇理由 |
|---|---|---|
| 九個 `npm run test:module -- <module>` | 全部有最終通過紀錄；各報告保留早期失敗與skip | 每個修改模組自己的typecheck/unit/host／browser整合 |
| `npm test` | 10/10 stages | 多模組修改的根基本檢查 |
| `npm run typecheck` | 9/9 stages | TS/schema/interface修改 |
| `npm run test:cross` | 3/3 stages | 根scripts/fixtures、docs/*.json provenance與多模組改動 |
| `npm run test:package` | 19/19 stages；2026-10-08T01:53:11Z–01:59:50Z | runtime worker合約改變，驗證實際tarball及乾淨production dependencies |
| `npm run build` | no-op成功，不算編譯覆蓋 | TS直接載入的既定入口 |
| `npm run sources:verify` | 通過，保留歷史delta warning | provenance完整性，不聲稱historical diff等價 |
| Checklist／LF | 53 unique IDs、38 checked/15 remaining；83 reviewed files為LF | 交付一致性 |

- Web最終補強後完整重驗：typecheck、70 unit、14 real-browser、2 browser/read composition，全通過。
- Subagents最終：263 unit、36 real Pi1.0.0 host integration；targeted72，全通過。
- File unit有1個Windows POSIX-path skip；PTY integration有1個POSIX-only signal skip，均不當測試通過。
- Package19階段包括pack dry-run/實際tarball、clean Pi1.0.0 install、native PTY setup、production dependency tree、PTY/JSON/Web worker handshake與重用/確認termination、JSON runtime、SDK/hooks與full/read-only/no-tools/exclude/Brave/Exa/invalid modes、managed child與cleanup。沒有遠端發布。
- Tarball evidence：127 files／316025 bytes，SHA-256 `451169935c97fc2a60060dab6bd97be5ddd4d35f7b625d423ab274c6febada39`；scratch產物由smoke清理，非宣稱保留下載檔。
- 當時證據索引：`plan/evidence/unit.json`、`typecheck.json`、`cross.json`、`package.json`、`module-*.json`及相應log。這些共用runner路徑會被後續執行更新，不能把目前同名檔案當成本段舊快照；原tarball/time/hash及各報告保留歷史身份。第一階段起始證據另存 `plan/evidence/unresolved-phase1/before-*.json`，其中before-module-subagents僅含typecheck stage，不代表完整模組驗證。

## 未完成／保留事項

- **部分5項**：H2 DNS rebinding無IP pinning／egress enforcement；M10 atomic replacement ACL/硬連結；L5外部writer TOCTOU；L8沒有通用secrets DLP／retention變更；L19拒絕超大relative但保留+0s/date-only政策。
- **政策待決5項**：MH1字面@新路徑慣例（目前可用`./@types/...`）；M11 diff timeout不提交；L11 blocked主導覽fail-closed；L12全文temp保留；L13 context-close timeout後slot release。
- **理由保留5項**：L1 spool ack/backpressure；L2不同transaction時點hash/scan；L7提交前完整重讀hash；L23最多999ms碰撞時間漂移；L30 per-chunk owner fence。不能為小幅效能移除安全／完整性保障。
- Web worker terminate失敗且永不exit會保留ownership並持續等待shutdown；沒有假釋容量，必要時重啟host。startup crash/OOM、hung-context-close fault injection與多FetchService獨立pool未驗證。
- Schedule same-session跨process distributed run ownership、mixed-version peers、direct-save stale snapshot overwrite仍有限制；未做兩process stress。
- 未額外重跑全根 `test:integration`／完整`check`，因module＋cross已涵蓋對應分組，避免重複；未跑人工TUI、真實provider/付費模型、WSL/SSH及真正POSIX整棵process tree終止。Web使用現有Chromium，未重裝browser。未執行不算pass。
- 額外第一個read-only reviewer已回報失敗：RPC startup `get_state` 未在期限內回覆（COMMIT_FAILED / RPC_DEADLINE，exit1、totalTokens0），沒有可採用審查結論，不算pass；job `01m4cjj138zhd6x1awahpj6ted`。這是額外審查執行失敗，不是已完成unit/module/cross/package的測試失敗。第二個reliability reviewer當時已完成靜態審查並提出M4 ownership warning；當時補修／重驗中，後續完成狀態見本報告頂部附記，仍不能稱全面安全。

## Provenance與歷史限制

初始沒有`.git`，以578-file SHA-256 inventory區分本次與既有變更。76 reviewed local snapshots中51項在開始前就不符舊記錄；本次保存baseline、previousRecorded與目前hash及review reason，保留immutable `docs/sources.json`／originalSha256，不盲目冒稱來源等價。

Verifier：195 imported local paths、93 added integration files、28 native files；0 original source files checked；43 recorded historical delta warning保留。舊內容不可取得者標historicalDeltaAudit unavailable。Root fixture理由已修正原先移除所有schedule_*的過時敘述與undefined片段。

## 詳細報告

- `report/code-review-checklist.md`：完整53項處置矩陣與歷史原始發現。
- `report/REPORT-20261008T015422424Z-subagents-checklist-修補與既有修補驗證.md`
- `report/REPORT-20261008T014844780Z-file-tools-checklist-修補與驗證報告.md`
- `report/REPORT-20261008T014745109Z-web-tools-checklist-修補與現況驗證.md`
- `report/REPORT-20261008T014742245Z-schedule-prompt-checklist-修補與現況驗證.md`
- `report/REPORT-20261008T014456359Z-pty-checklist-修補與驗證報告.md`
- `report/REPORT-20261008T015010367Z-json-schema-checklist-修補與回歸驗證-m8-m9-l32.md`
- `report/REPORT-20261008T014246317Z-note-tools-gpt-speed-審查修補結果-m16-l20-l23.md`
- `plan/PLAN-20261008T013606594Z-code-review-checklist-逐項修復追蹤.md`

沒有修改真實全域settings/auth/provider credentials／使用者排程，沒有付費provider呼叫，沒有GitHub/npm發布。