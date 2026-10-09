# Web-tools checklist 修補與現況驗證

## 結論與範圍

已完成授權範圍 `modules/web-tools/**` 的現況查證、M12 worker pool 補強及回歸驗證。H2 僅有事後對端位址檢查，不能宣稱 IP pinning 或完整 SSRF 修復；L11／L12／L13 保留已文件化政策，未單方面改變行為。

比對父 agent 提供的 `%TEMP%/pi-better-review-baseline.json`：任務開始前已存在 M12 的 extraction worker、M13 的 image／stylesheet 阻擋、L10 的單次 fetch DNS memo，以及 H2 的 `APIResponse.serverAddr()` 緩解。不得將這些既存修改算成本輪新增修復。

已讀 checklist、模組 README、software-fix-bugs／test-case-creator skills；模組內未找到額外 AGENTS.md。本輪沒有変更 Pi SDK API，沒有修改根 checklist、scripts、tests 或 provenance；父 agent 另行處理既存 provenance mismatch。

## 逐項結果

### H2 — 部分修復：既存緩解已驗證，根本限制保留

- `src/fetch/service.ts` 的每個 `route.fetch({ maxRedirects: 0 })` 回應，在處理 redirect／fulfill 前呼叫 `policy.assertConnectedAddress((await response.serverAddr())?.ipAddress)`。
- `src/fetch/network.ts` 對私有、特殊、無法解析或缺少 peer address 的回應 fail closed；每個 redirect hop 都經同一檢查。這不是 preflight DNS 與連線的原子綁定。
- 新增真實 Chromium／本機 HTTP fixture 回歸：模擬「preflight 已核准」，但實際連到 loopback；主文件拒絕使用、非公開 peer 的 redirect 不往下一跳走、子資源拒絕使用並產生 warning。
- 回歸同時斷言 fixture 已收到原始請求：事後檢查無法防止 blind SSRF 或有副作用的 HTTP 請求，不能將 DNS validation、DNS cache 或 response peer check 描述成 pinning。
- 官方 APIResponse 文件確認 `serverAddr()` 取得伺服器 IP／port，無位址時為 null，redirect chain 回報最後一跳；因此現有 `maxRedirects: 0` 逐跳處理不可刪除。參考：`https://playwright.dev/docs/api/class-apiresponse#api-response-server-addr`。
- 官方 Route.fetch options 未提供自訂 connection lookup／已驗證 IP pinning。參考：`https://playwright.dev/docs/api/class-route#route-fetch`。
- **可行根治方向（尚未實作、需父／使用者決策）：** 用強制出口过滤 proxy／OS egress policy，在連線前阻擋私有網段；或重寫 Node transport，將 validation 得到的位址交給受控 lookup，並正確保留 TLS certificate verification／SNI、hostname、cookies、headers、redirect、解壓與 streaming byte limits。後者不是安全的小 patch，且只處理 HTTP transport 不等於限制所有 Chromium background traffic。
- 不採用「將 URL hostname 直接改成 IP」或關閉 TLS 驗證的捷徑。不新增可關閉 public URL policy 的設定。建議 checklist H2 保留未根治／部分緩解標示。

### M12 — 原問題已先前修復；本輪補強 worker 生命週期

- 渲染 HTML 的 JSDOM／Readability parsing 已由 `extractHtmlIsolated()` 經 `extract-worker.mjs` 執行，service 將 deadline／cancel／shutdown signal 傳給 worker runner。
- 本輪修正 `acquire()` 移除全部 exit listeners 的問題：不再刪掉 startup／lifecycle handler；每個 worker 維持一組 error／exit lifecycle listeners，單次 job listeners 完成後才移除。
- retire 改為冪等，避免 worker exit 再次 retire／terminate；idle error／exit 也會移出 pool。
- 活動 worker `ref()`，idle worker `unref()`：避免只剩正在執行的 extraction 時 Node 因 unreferenced worker 提早退出。
- 將 5 MiB HTML byte check 放在複製進 worker 前；ready failure／postMessage exception 收斂成既有安全錯誤，不遺留未 settle promise。
- 新增重用 12 次回歸，驗證活動階段同時存在 lifecycle＋job exit/error listeners，閒置只留 lifecycle、無殘留 message listeners，並實際重用同一 warm worker。
- 強化取消回歸：先 warm worker、使用小於 5 MiB 的 markup、僅接受 TIMEOUT，監測實際 `Worker.terminate()` 呼叫次數，並驗證之後可恢復 extraction。舊測試允許 TOO_LARGE／EMPTY_CONTENT，無法可靠區分真的取消與資料上限錯誤；本輪未放寬斷言。
- 父 agent 追加安全要求後，新增 module-global `owned` 帳本與 `MAX_EXTRACTION_WORKERS = 6`：活動、閒置、終止中的 worker 合計共用上限；取消／timeout 不提前 release，只在實際 exit 或 terminate 成功完成才釋放。終止失敗也保留 ownership，滿載回報既有 BUSY 錯誤，不重試建立更多 threads。
- `shutdownExtractionWorkers()` 涵蓋全部 owned workers（包括活動與已終止中）、停止新 acquisition／prewarm，且回傳等待實際退出的 Promise；`FetchService.close()` 先取消本服務 operations，再等待 worker cleanup，不改變 L13 的 context close 5 秒政策。
- 新增確定性 delayed／rejected terminate regression：連續取消滿 6 個 worker，刻意阻止實際 terminate；多次 extraction 重試及 prewarm 仍不增加 threads；注入一次 terminate rejection 亦不釋放名額；shutdown 不提早完成，也不重複 terminate；手動允許實際退出後釋放容量。另驗證未取消的活動 worker 也由 shutdown reaped，shutdown 期間不接受新工作，之後 extraction 可恢復。沒有靠固定 sleep／idle 判斷退出。
- README 同步說明 pre-transfer byte check、ref/unref、listener/pool lifecycle、總量上限、BUSY 及 shutdown ownership。
- 尚未 fault-inject worker startup crash／OOM；worker heap cap 不等於完整 OS sandbox 或總記憶體上限。單次 caller rejection 不代表 worker 已退出，帳本仍占位。若 terminate 失敗且永無 exit，shutdown 會持續等待、容量不重用；安全優先於虛假完成，可能需要重啟宿主。pool／shutdown 為 module-global；production extension 使用單一 FetchService，多服務實例的獨立 pool lifecycle 不在本輪設計範圍。

### M13 — 已先前修復，本輪確認回歸

- 現有 route 在送出 request 前 abort 非主導覽的 media／font／image／stylesheet。
- 既有真實 Chromium regression 確認 `/style.css` 與 `/pic.png` 沒有 fixture hits，頁面文字仍可抽取；SPA script／hydration 測試仍通過。
- content-length 與實際 body 上限保留。Playwright 先緩衝 body，因此 10 MiB 是交給 browser 的 acceptance limit，不是 streaming transfer／peak-memory cap；沒有誇大此防護，也沒有為修補放寬 public URL policy。

### L10 — 已先前修復，本輪確認回歸

- 同一次 service.fetch 建立一個 `ValidationCache`，每個 canonical hostname 共用 Promise，包括失敗；不同 fetch 不共用。
- 既有測試覆蓋成功 memo／失敗 memo／不傳 cache 不 memo；初始 URL、redirect、子資源、最終 URL 均經 validate，实际 connected address 仍逐回應檢查。
- DNS memo 是性能改善，不是 connection pinning。cached validation 不保證後續連線解析結果相同。

### L11 — 保留 fail-closed 政策，不視為待改 bug

- 被擋主導覽不回傳舊頁正文；被擋子資源只 warning 的既定區分未改。
- 新增真實 JS `location.replace()` 回歸：允許 fixture 初始頁、對 `/forbidden` 導覽套用正式 private-address policy，斷言 NETWORK_BLOCKED、目的 endpoint 沒有 hits，而非成功回傳 stale document。
- 初版測試把 JS 導向多跳 redirect 的錯誤碼限定 INVALID_URL，但實際可能由 deadline 結束；後改為直接 blocked navigation fixture，以精確驗證 fail-closed 契約，未將 TIMEOUT 納入成功條件。
- 若要在被擋導向後回傳舊頁，須由使用者明確改變政策；本輪不做。

### L12 — 保留輸出暫存檔 retention 政策

- README 明定全文 temp 不在 shutdown 刪除，供後續 read 分頁使用。沒有新增 shutdown cleanup／TTL／數量限制。
- 既有 output regression 新增 service.close 後重讀 fullOutputPath，確認文件承諾仍成立；測試最後自行刪除自己建立的 temp directory。
- 風險仍為大量長輸出累積 temp／敏感網頁內容保留至 OS cleanup。若要改，需先決定 retention 時間／數量與既有 fullOutputPath 可讀性的契約；建議不要把未作政策變更標為 bug 已修。

### L13 — 保留有界 context close 與 slot-release 取捨

- 現有 context.close 共用第一次 close promise，finally 最多等待 5 秒後 release slot；idle／service shutdown 負責 browser cleanup。此政策未改。
- 真實 browser cancellation、queue shutdown、context cleanup 與 idle reap 的既有回歸通過；本輪未新增 hung-close fault injection，也不宣稱已根治 hung context。
- 風險仍是 close hung 時 context 可能暫存而 slot 已釋放。若要轉為保留 slot、隔離／淘汰整個 browser 或 fail service，需先決定多個並行 fetch 的取消與可用性影響。

## 本輪相對 baseline 變更／新增檔案

- `modules/web-tools/src/fetch/extract.ts` — worker lifecycle、ref/unref、冪等 retire、pre-transfer HTML limit、安全 ready/postMessage failure、活動／閒置／終止中共同上限及實際退出 ownership、全 owned shutdown。
- `modules/web-tools/src/fetch/service.ts` — close 先取消 operations，再取得並等待 worker shutdown Promise。
- `modules/web-tools/tests/unit/fetch.test.ts` — listener reuse regression、嚴格取消／terminate／恢復 regression、延遲／失敗 terminate 與 active shutdown 的確定性容量 regression。
- `modules/web-tools/tests/integration/fetch.test.ts` — H2 真實連線緩解／blind-SSRF 限制 regression、L11 JS fail-closed regression；H2 fixture 先預熱 worker以排除 jsdom 冷啟動對連線檢查案例的影響。
- `modules/web-tools/tests/unit/output.test.ts` — L12 shutdown 後全文 temp 可讀 regression。
- `modules/web-tools/README.md` — worker lifecycle 補充。
- 沒有新增模組 source/test 檔案；此報告由 note 另行新增。上述六個模組檔案均確認 LF。

主要 functions/types：`spawn`、`removeIdle`、`releaseOwnership`、`retire`、`park`、`acquire`、`extractHtmlIsolated`、`shutdownExtractionWorkers`、`FetchService.close`、`Pooled`、`MAX_EXTRACTION_WORKERS`。

## 實際執行驗證

選擇單模組分組，因只修改 web-tools（含本模組測試與 README），沒有修改根 manifest／scripts／shared helpers／provenance。

1. 首輪 `npm run test:module -- web-tools`：3/4 stages 成功；typecheck、68 unit tests、2 browser/read composition probes 通過；real-browser 的既有 deadline/idle 案例因冷啟動／環境速度 TIMEOUT 失敗。此輪不算整組通過。
2. 中途 targeted：`node --import tsx --test modules/web-tools/tests/unit/fetch.test.ts modules/web-tools/tests/unit/output.test.ts modules/web-tools/tests/integration/fetch.test.ts`：32/36 通過、4 fail（含父 test），失敗為首次 SPA cold timeout、初版 L11 錯誤碼假設、H2 成功 extraction cold timeout。單元與取消回歸通過。此輪不算通過。
3. 追加 ownership 補強前的 `npm run test:module -- web-tools`：**4/4 stages 全部成功，沒有 skip／cancel／todo**：
   - web-tools:typecheck：通過。
   - web-tools:test：69/69 通過。
   - web-tools:real-browser：14/14 通過（含 H2、L11 新回歸）。
   - all-modules:web-read（runner 內屬於 web-tools 的既有 composition stage）：missing-browser／real-browser 2/2 通過；real probe 確認 rendered、truncated、paginatedRead、browserClosed。

4. ownership 補強後 targeted `node --import tsx --test modules/web-tools/tests/unit/fetch.test.ts`：20/20 通過；此輪為 delayed terminate 版本，後續增加 terminate rejection 分支亦由最終分組驗證。
5. **最終 ownership 補強後 `npm run test:module -- web-tools`：4/4 stages 全部成功，無 skip／cancel／todo**：typecheck 通過、70/70 unit tests（含 delayed／rejected termination 容量 regression）、14/14 real-browser tests、2/2 browser/read composition probes。此輪代表最後 source/test 狀態。

最終 log：`C:\Users\KY6584\AppData\Local\Temp\pi-shell-job-eZb5K8\output.log`。
ownership targeted log：`C:\Users\KY6584\AppData\Local\Temp\pi-shell-job-IhYc2l\output.log`。
追加補強前完整通過 log：`C:\Users\KY6584\AppData\Local\Temp\pi-shell-job-m05KWp\output.log`。
首輪 log：`C:\Users\KY6584\AppData\Local\Temp\pi-shell-job-2rRupP\output.log`。
中途 targeted log：`C:\Users\KY6584\AppData\Local\Temp\pi-shell-job-LlbqG0\output.log`。

未額外執行全根 `npm test`、全根 typecheck、test:cross、全部 test:integration、test:package／check；不把未執行分組算通過。沒有執行 browser:install，環境已有可用 Chromium。沒有使用真實 credentials／付費 provider，也沒有更動真實 settings/auth。

## 交接與剩餘決策

- 父 agent 可將 M12／M13／L10 標為已先前修復＋本輪驗證，M12 另記本輪 lifecycle 補强。
- H2 保留部分緩解，不能標成已完成 IP pinning；L11／L12／L13 標成政策保留／需決策，勿當作未交代的漏修。
- 請父 agent 更新根 checklist、相關 root docs／provenance／hashes；本 worker 不越權修改。
- 測試環境負載會影響冷啟動耗時（本輪觀察 jsdom 約 10 秒）；最終組通過不消除低 timeout 設定的冷啟動風險。未降低安全斷言，也未修改 deadline 保含 queue/browser startup 的對外語意。
