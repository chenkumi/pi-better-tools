# JSON Schema

讓非互動（print）執行產出經 JSON Schema 驗證的結構化結果，寫入檔案或 stdout。原生實作，以 zod 4 驗證；不再使用 Ajv。

## CLI 旗標

| 旗標 | 說明 |
| --- | --- |
| `--json-schema` | JSON Schema 字串，根必須為 `type: "object"`；給了就啟用 |
| `--json-output` | 輸出檔路徑（相對於 cwd）。有給＝寫入檔案；沒給＝結果以單行 JSON 輸出到 stdout |

```bash
# stdout：整個 stdout 就是一行 JSON
pi -p --json-schema '{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"]}' "回答問題"

# 檔案
pi -p --json-schema "$schema" --json-output result.json "回答問題"
```

設定無效、需要 print 模式（`-p`；不支援 `--mode json`）或 schema 不被支援時，錯誤寫到 stderr（前綴 `pi-json-schema:`）、exit code 為 1，且**不發出任何模型請求**。

## 運作

啟用後註冊 `json_output` 工具（僅模型可用，參數即所給 schema），指示模型呼叫一次、作為最後一步，且參數本身即結果（tool description 已涵蓋，不另加 prompt guideline）；驗證通過即結束這次執行，不再多一輪模型請求。

驗證失敗不會使整個執行失敗：`json_output` 以**工具錯誤**回給模型，模型可依錯誤訊息修正後重試。目前沒有重試次數上限（受模型自身的回合與成本限制）；模型始終不給出有效結果時，會落入下方的 best-effort 回收。

- file：原子寫入（暫存檔後 rename），2 格縮排 JSON 並結尾換行；rename 遇到暫時鎖定（EPERM／EBUSY／EACCES）最多重試 8 次、累計等待 1.32 秒，失敗時保留舊檔並清除暫存檔。
- stdout：單行 JSON 加換行。結構化輸出的執行不會把助理的說明文字印到 stdout；每次執行只接受一個 prompt（要多個請用 `--json-output`）。
- 只接受一個結果；內容不同的第二個結果視為衝突並失敗。
- 交付的是模型給的原始資料，不套用 schema 的 `default`，也不做型別轉換。

## 沒有呼叫 `json_output` 時（固定 best-effort）

1. 先從最後一則助理訊息解析 JSON（依序嘗試整段、各 ```json 區塊、平衡的 `{…}`／`[…]` 候選），採用第一個通過 schema 驗證的候選；可解析但不符合 schema 的 `{}`／陣列等不會阻止後續候選。
2. 否則以一次額外的模型呼叫（60 秒期限、不重試）要求抽取，接受 `json_output` 工具呼叫或回應中的第一個 schema-valid JSON 候選；呼叫其他工具視為失敗。雖然交付前會抑制 stdout 的助理文字，抽取用 transcript 仍保留各則助理訊息的原始文字區塊與順序，不修改宿主的訊息。
3. `json_output` 被工具選取排除（`--no-tools`、`--exclude-tools`）時不做抽取呼叫並失敗；步驟 1 仍可用。
4. 使用虛擬路由模型時，抽取呼叫使用實際回答的模型。

## 失敗處理

上游請求出錯／中止、收到 SIGTERM（非 Windows 另含 SIGHUP）、`json_output` 驗證失敗、結果衝突或無法取得有效結果時，不交付任何內容、錯誤寫入 stderr 並設 exit code 1。

## 支援的 schema 範圍

從文字回收 JSON 時，花括號／方括號掃描有上限（最多 64 次候選、每次最多 1,000,000 字元），超過即視為找不到。

以 zod 4 的 `z.fromJSONSchema` 驗證，涵蓋常見關鍵字：`type`、`properties`／`required`／`additionalProperties`、`enum`／`const`、`anyOf`／`oneOf`／`allOf`、字串／數值／陣列／物件約束、`format`、本地 `$ref`（含遞迴 `#`）、draft-07。

zod 無法忠實驗證的內容會**在啟動時被拒絕**，避免悄悄放行錯誤資料：

- `if`／`then`／`else`、`not`、`dependentRequired`／`dependentSchemas`／`dependencies`、`unevaluatedProperties`／`unevaluatedItems`、`$dynamicRef`／`$anchor`、外部 `$ref`。
- 陣列形式的 `items`（draft-07 tuple）會逐元素稽核，同樣套用以上規則。
- 沒有 `type`（也沒有 `$ref`／`enum`／`const`）卻帶型別專屬約束的子 schema，例如 `allOf: [{type:"string"}, {minLength:3}]` 的第二項；zod 會忽略這類約束，請補上 `type`。

### 驗證安全限制

- `enum`／`const` 與 zod 會忽略的同層字串、數值、陣列、物件、組合或 `$ref` 約束一起使用時，在啟動時拒絕；`enum` 與 `const` 同層併用、值與宣告 `type` 不符亦拒絕，避免錯誤交付。
- `pattern`／`patternProperties` 僅接受保守線性子集：最多 200 字元，不含群組、alternation 或 `{…}` 次數量詞；最多一個 `*`／`+`／`?` 且須以 `^` 開頭，只接受指定跳脫及合法字元類別。例如 `^a+$`、`^[A-Z]+$` 可用，`(a+)+$`、`^(a|aa)+$` 不可用。這是本地限制，並非完整 JavaScript RegExp 支援；本地 `$ref` 定義與 draft-07 tuple 的 `additionalItems` 尾項也會稽核；尾項 pattern 亦選用 worker 驗證。
- Pi 在工具執行前同步驗證參數，因此不能只靠 extension worker 隔離危險 pattern。啟動稽核通過、含 pattern 的本地驗證使用可重用 worker pool：最多 4 個 worker、FIFO 等候隊列最多 256 件，滿載時回報容量錯誤；排隊可取消。worker 啟動／載入 zod 有獨立 10 秒上限，ready 後每件驗證（含 schema 編譯）有 2 秒期限。每個 worker 只快取最後一個 schema 的 validator，閒置時不阻止行程退出且 30 秒後回收；session shutdown 會等待終止。容量／期限／取消失敗不交付資料，取消或故障的 worker 確認退出／終止才歸還名額。不含 pattern 的驗證維持同步路徑。

## Provider 相容性警告

`json_output` 的參數 schema 會原樣交給 provider 作為 tool 參數 schema，各 provider 對 JSON Schema 子集的支援不一：部分 provider 會拒絕或忽略 `$ref`（含遞迴）、`oneOf`、`format`、`additionalProperties`，甚至要求特定寫法（例如物件必須明列 `additionalProperties: false`）。本模組的 zod 驗證僅在本地執行，不保證 provider 端會強制同一組約束。遇到 provider 回報 schema 無效時，請改用較平坦的 schema（內嵌取代 `$ref`、`anyOf` 取代 `oneOf`、少用 `format`）；最終正確性以本地驗證為準。
