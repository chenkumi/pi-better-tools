# 四筆 Shell background failure 唯讀確認

## 結論與範圍
2026-10-08，依使用者提供的四筆Shell failed/exit1通知，完整讀取四份output.log並唯讀檢視目前verify-live.mjs。判讀：均有命令內部實際錯誤輸出，Shell失敗通知與資料一致；未發現足以認定Shell啟動故障或成功被誤判失敗的證據。「正常回報失敗」不代表測試正常通過、錯誤可忽略或刻意negative fixture。

本次不重跑命令／live API、瀏覽器、build或資料修改；不修程式碼、不查真實auth。沒有做Shell執行器端到端重現；第一筆完整command／callback未取得，encoding最初capture步驟未重建。

## 已觀察項目
### SHELL-CHECK-001：9xsYAp — runtime reference error
- 證據：`C:/Users/KY6584/AppData/Local/Temp/pi-shell-job-9xsYAp/output.log`，完整4行，SHA256 token `8d7a957a2e00d7977c2ae14c45334e1c`。
- 開始訊息已輸出，CLI報`ReferenceError: page.waitForResponse: URL is not defined`。
- 已確認命令內部發生reference error；URL在哪個callback／CLI evaluation環境未定義，須完整呼叫或stack查證。不是證明網路URL無效、timeout或Shell spawn失敗，亦不能只凭這份log指認網站產品bug。

### SHELL-CHECK-002：TiocZ7、yAyV3U — 同一斷言失敗
- 證據：`C:/Users/KY6584/AppData/Local/Temp/pi-shell-job-TiocZ7/output.log`，完整628行，token `7d0c7abbb28a057e0b76826969edb4b6`；`C:/Users/KY6584/AppData/Local/Temp/pi-shell-job-yAyV3U/output.log`，完整620行，token `dd80ee7ec609c568b740937129bcbb21`。
- 同為Node `ERR_ASSERTION`／`deepStrictEqual`，訊息`Administrator template identity/state/timestamps preserved`，歷史stack指向`D:/projects/smart-reports/.tmp/unified-stock/verify-live.mjs:12:8`。
- 實際title為正確中文，如總經銷庫存時間；expected為`ç¸½…`等mojibake。Diff列出title不相等，並非只有通知畫面顯示亂碼；不能從斷言名稱推論ID、state或timestamps也改變。
- TiocZ7尾端的PowerShell `Unified live API verification failed`是捕捉Node非0後的包裝throw，不是另一項獨立根因。yAyV3U直接顯示Node斷言，因此兩筆歸為同類問題，非兩種Shell故障。
- 目前`D:/projects/smart-reports/.tmp/unified-stock/verify-live.mjs`（token `b6a67688ff19f8c49a5c2bc3a5e26134`）18行在baseline上呼叫repairBaselineEncoding；6–17行註解與邏輯處理可逆Latin-1／UTF-8混用，24行才執行identity斷言。此檔與歷史stack行號不同，已有encoding處理；只是目前source觀察，未重跑，不宣稱現在已通過，也不以註解單獨證實最初capture根因。
- 尚未定位原始baseline擷取／解碼錯誤由哪個步驟造成；不能完全排除PowerShell編碼處理的影響，但非證據支持background管理器或renderer本身導致本次斷言差異。

### SHELL-CHECK-003：0FyCIZ — TypeScript build failure
- 證據：`C:/Users/KY6584/AppData/Local/Temp/pi-shell-job-0FyCIZ/output.log`，完整73行，token `dccded3c224ac397d66b9b6303c691b1`。
- 實際執行`smart-reports`的`npm run build`；web步驟`tsc -b && vite build`在編譯失敗。
- `src/pages/statistics-templates-page.test.tsx`的363、364、366、369、370、373、376、377、402、405、407、409行出現TS2769：`exact`不在`ByRoleOptions`型別中。這是測試程式呼叫的型別錯誤；未查source／dependency版本，不擴大推論API版本或指定修法。
- npm記錄workspace `D:/projects/smart-reports/apps/web`、exit1；`.tmp/unified-stock/validate.ps1:5`再throw驗證失敗。這不是Shell timeout或spawn失敗。此validation pipeline已在build失敗，不能宣稱其後驗證完成。

## 通知呈現與限制
四筆均通知exit1，所附完整log有實際runtime／assertion／compiler錯誤；目前沒有取消、timeout或Shell ownership問題的證據。Command截短、Only part of the output retained、Expand提示為顯示保留範圍，不是新的錯誤。不能因exit1或沒有timeout字樣就概括保證Shell永無bug。

這些log屬`D:/projects/smart-reports`工作／驗證，不是先前Pi Better Tools RPC diagnostics那次已通過的validation job。只新增本確認紀錄，未改兩個專案產品檔案或原始logs。
