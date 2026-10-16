# JSON Schema：print 模式結構化輸出

## 指令與工具

本模組使用 CLI flags，不提供 slash 設定命令：

- `--json-schema <schema字串>`：根必須 `type: "object"`；提供後才啟用。
- `--json-output <path>`：相對 cwd；省略則 stdout 為單行 JSON。
- 條件式模型工具 `json_output`，由模型提交符合 schema 的結果；一般互動 session 不啟用。

```bash
pi -p --json-schema '{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"]}' --json-output result.json "回答問題"
```

上例是 Bash 的 quoting；PowerShell 請依 shell 傳入同一個 JSON 字串，不直接照抄無效 quoting。

## Config 與作用範圍

**沒有持久 JSON config 鍵。** Schema 與輸出位置由本次 CLI invocation 決定。需要 print `-p`；不支援用 `--mode json` 取代。設定錯誤會在模型呼叫前拒絕。

- stdout 模式只接受一個 prompt，失敗時不交付 JSON；檔案模式採原子取代，失敗保留既有結果。
- 支援常見 type／properties／required／enum／組合與本地 definitions 引用；條件式、外部引用、不支援的 regex 等會拒絕，未支援的鍵會在啟動時拒絕；優先使用上述基本子集，不以更換 validator 設定繞過。
- 沒有有效 json_output 時可從最後文字回收；必要時有一次額外模型抽取，可能增加費用。工具被排除時不能靠抽取繞過工具限制。
- Provider 能接受的 schema 子集不等於本地驗證範圍；遇拒絕可依需求簡化 schema，但不放寬使用者要求的結果約束。

先靜態核對 flags／schema／輸出路徑；真正執行會呼叫模型，需在使用者授權範圍內。
