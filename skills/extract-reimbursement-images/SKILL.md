---
name: extract-reimbursement-images
description: "baox 图片字段提取的内部执行壳。Invoked only when baox returns an extract_images step; runs the managed local OCR batch and uses model vision solely for items the coordinator explicitly returns as needs_model_vision."
user-invocable: false
disable-model-invocation: false
allowed-tools: Bash, Read, Write
---

# extract-reimbursement-images

这是 `baox` 的内部深模块，不是用户入口。用户始终只知道 `baox`。

你只接收 `baox next` 返回的 `step.kind: "extract_images"` 工单。工单中的路径、图片清单、
内容哈希和提交命令都由内核生成；不要自己发现图片、增删图片、选择 OCR 引擎或调整阈值。

## 执行本地批处理

使用本 Skill 目录里的已编译 CLI，并把工单路径原样代入：

```bash
node "<这个 skill 目录的绝对路径>/runtime/dist/cli.js" --request "<step.requestPath>" --output "<step.extractionPath>" --readings "<step.readingsPath>"
```

CLI 只做三件事：复核文件哈希和格式；让一个 Python Worker 批量读取；用 TypeScript 规则输出
封闭 schema。不要绕过 CLI 直接调用 Python，也不要自行安装依赖。

## 结果纪律

- 本地 `extracted` 结果按原样交回；增值税发票的 OCR 候选只包含 `fields.totalAmount`，不要从
  文字观测补写发票号码、不含税金额、税额或其他字段。
- `ride_itinerary` 的 `segments[]` 按票面顺序完整保留；每个可见表格行都是独立行程段，不合并、丢弃、
  重排，也不用顶层合计替代逐段金额。
- OCR 候选只是字段候选，仍交给内核和用户确认；不要在 Skill 内自行确认或改写字段。

## 明确回退

读取 `step.extractionPath`：

- `extracted` 已写入 `step.readingsPath`，不要再看原图或改写候选；
- `failed` 是确定性失败，照实留给主流程处理，不要补值；
- 只有 `needs_model_vision` 才允许用 `Read` 打开该项对应的 `absPath`。

模型视觉回退时，按 `step.schemaPath` 逐字抄写并把该材料追加到 `step.readingsPath`。保留 CLI
已有的 `readings`；不得覆盖、重排或“纠正”本地 OCR 结果。票面看不清就写入 `unreadable`，
不要根据文件名、上下文、金额守恒或常识补值。回退项必须带工单给出的 `materialId` 和
`contentHash`，`source` 写 `vision`，并按旧协议填写 `sighted.shape`。

## 交回

完成后原样执行 `step.argv`，把 stdout 落到 `step.resultPath`。回到 `baox` 主会话时只交回该
结果路径和原始工单；不把 OCR 原文或图片内容贴进对话，不把这个内部 Skill 报给用户。

若本地运行时不存在，停止并把环境错误交回主流程；Setup 本应在材料解析前完成安装，不能把
缺少工具伪装成图片证据不足。若 CLI 协议失败、工单哈希变化或一张图含多份单据，同样停止并
原样带回错误，不把结构性失败降级成猜测。
