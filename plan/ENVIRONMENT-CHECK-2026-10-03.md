# 目前環境運行檢查

## 結論

本機核心功能可載入及執行，但不能宣稱完整驗證通過或 production tarball 已可正常運行。存在跨平台測試假設、封裝契約不一致及來源追蹤不一致；本輪未修改產品或測試程式碼。

## 基準與操作

- 日期：2026-10-03；commit：`f14b8377cdbe366c5251718a5564bba2ad991def`。
- macOS / Darwin ARM64，Node.js v26.5.1，npm 11.17.0，全域 Pi 1.0.0；根開發依賴 Pi 1.0.0。
- 初始 Git working tree 乾淨，沒有 node_modules。
- 執行 `npm ci --ignore-scripts --no-audit --no-fund` 成功（343 packages）；建置 Scheduler CLI，安裝 Playwright Chromium。上述為本機依賴／建置／瀏覽器資源，未執行 pi install 或修改真實全域 settings/auth。
- 測試使用既有隔離 fixtures 與離線 provider，未呼叫付費模型或真實 provider credentials。
- 長時間執行經既有 test-process runner 定期輸出英文進度。所有檢查程序均已結束；既有測試負責清理其隔離資源。

## 實際驗證

| 指令 | 結果 |
| --- | --- |
| npm run build | 通過，1/1 stage |
| npm run typecheck | 通過，8/8 stages |
| npm test | 失敗，8/10 stages；Subagents 167/170，Web 55/56 |
| npm run test:integration | 失敗，8/9 stages；Subagents 10/23 |
| npm run test:package | 失敗，dry-run 資源斷言阻擋後續 tarball／乾淨 production install |
| npm run browser:install | 通過 |
| npm run test:browser | 通過，2/2 stages；真實 Chromium 11 項、Web/File 組合 2 項均通過，無 skip |
| npm run sources:verify | 失敗，第一個不一致為 Shell timeout-ms.ts |

整合中 Shell（非 Windows cases）、File、Scheduler、Goal real Pi runtime、JSON Schema real CLI、Scheduler TS loader、SDK hooks、九個模組一起載入的八種模式均完成且無失敗。Shell integration 有 1 項平台 skip；File unit 有 11 項 Windows-only skip，均不算通過。

## 發現與證據

### 1. 封裝驗證契約不一致：阻止 production 安裝驗證

`npm run test:package` 在 `scripts/package-smoke.mjs:55` 報 `missing tarball resource modules/shell-tools/LICENSE`。repository 本身也沒有該檔案；`required` 清單卻要求它。

因此本次沒有完成真實 tarball、乾淨 production dependency install、production loader／guard／worker／agents／prompts／runner probes。這是封裝／驗證契約問題，不能由本機載入成功推論 production tarball 全部正常，也不能僅據此認定 runtime 本身無法執行。

證據：`evidence/current-test-package.log`、`evidence/package.json`。

### 2. macOS canonical temporary path 導致 Subagent 測試失敗

- `modules/subagents/tests/always-managed.test.ts:43` 三種模式將 logPath 與非 canonical temporary path 做字串比較。
- `modules/subagents/tests/pi-cli.integration.test.ts:97` 十三個 cases 使用 `result.logPath.startsWith(root)`。
- 實際 logPath 為 `/private/var/folders/...`，測試 root 為 `/var/folders/...`（macOS symlink alias）。
- 診斷重跑僅將該子程序的 TMPDIR 設為 `realpathSync(tmpdir())`，沒有改斷言或產品程式碼；always-managed + pi-cli 合計 26 項，25 通過、1 失敗。這證實路徑 alias 是上述多項失敗的原因，但不是整個 suite 已通過。

證據：`evidence/unit.json`、`evidence/integration.json`、`evidence/current-subagents-canonical-tmp.log`。

### 3. Subagent large-shell integration 不符合目前平台

canonical TMPDIR 重跑後剩下 `large-shell/single` 在 `pi-cli.integration.test.ts:121` 失敗：要求 powershell tool result `isError === false`。

fixture 實際要求 `powershell` 執行 `Write-Output ('x' * 614400)`；保存的 transcript 回傳 `The powershell tool is only available on Windows.`。這是目前 macOS 上不可用的 Windows-only backend，不是已證實的 Subagent payload regression。

證據：`evidence/current-large-shell-diagnostic.log`、`evidence/canonical-subagents/large-shell-single-0-subsession.jsonl`。

### 4. Web debug-log 單元測試使用 Windows 路徑假設

`modules/web-tools/tests/unit/debug-log.test.ts:11` 期待 `projectNameFromCwd('C:\\work\\my-project') === 'my-project'`，macOS 實際得到 `C__work_my-project`。

實作 `modules/web-tools/src/debug-log.ts:16` 使用 host-native `basename(resolve(cwd))`。目前證據顯示跨平台輸入測試契約不一致；一般 macOS cwd 的 debug-log 測試其餘通過，不能據此認定本機 debug logging 全面失效。

證據：`evidence/unit.json`、`evidence/web-tools-test.log`。

### 5. 來源 provenance 不一致

`sources:verify` 第一個失敗：`modules/shell-tools/extensions/timeout-ms.ts`。

- 實際 SHA256：`404d10dda33b578c06aec46451cada14758413e44b5c466a44dbff2c65381c5b`
- 預期 SHA256：`ea332aa731a69d182bb1e4f6361ba82455beda04a880019cf663a6d1cf97727f`

此指令在第一個錯誤即中止，其他 provenance 尚不能宣稱全部一致。不影響已觀察的 build/load 成功，但阻止完整來源查核。

證據：`evidence/current-sources-verify.log`。

## 限制與下一步

- 未執行 Pi 0.99.1／0.99.2 production matrix（目前 1.0.0 的 package probe 已被前置資源斷言阻擋）。
- 未做人工 fullscreen TUI、真實 OpenAI／Brave／Exa、付費模型、真實長期排程或 OS service 驗證。
- 建議先釐清 LICENSE／tarball required 資源契約與 provenance，再修正跨平台 fixture／canonical path 比較；不可弱化核心斷言或把 platform skips 算成通過。
- 本機依賴已備妥；需要互動試用且不改全域設定，可在新 terminal 使用 `pi --no-extensions -e /Users/ckm/GitHub/pi-better-tools`。仍須留意原工具包重複註冊及真實 session 執行所可能產生的資料／費用。

完整階段 exit codes：`evidence/current-status.txt`；原始輸出：`evidence/current-*.log`。`plan/` 為 Git ignored，本報告與證據僅保存在本機。
