# 图片字段提取设计

本文是 `extract-reimbursement-images` 的实现规格。领域语言以根目录 `CONTEXT.md` 为准；架构决定见 ADR-0011。

## Module and seam

图片字段提取是一个内部深模块，由 `baox` 调度，不是新的用户入口。外部 seam 只有一个批量 Interface：调用方提交在册图片材料，得到每份材料的合法字段候选或结构化失败。

```ts
extractImageFields(request: ImageFieldExtractionRequest): Promise<ImageFieldExtractionBatch>
```

请求包含 `contractVersion: 1` 和非空 `images[]`；每张图片只包含 `materialId`、`contentHash`、`absPath`。Interface 不接受 OCR 引擎、模型、阈值、重试次数或回退策略。

结果与输入等长、同序。每项是：

- `extracted`：封闭图片材料类型、字段候选、文字观测引用、适配器来源和耗时；
- `failed`：稳定错误码、是否可重试和处置建议。

请求版本、重复材料标识、非法哈希和非绝对路径属于请求级违约；文件变化、损坏、单图多单据、运行时缺失、超时和证据不足属于逐材料失败。

## Ownership

模块拥有：

- 文件头识别、图片解码和内容哈希复核；
- Python Worker 生命周期和 JSONL 协议；
- OCR 或模型视觉文字观测、图片材料类型、字段规则和确定性规范化；
- 封闭 schema、日期/号码/金额格式和金额守恒校验；
- OCR 与模型视觉的回退、冲突归并、来源和性能记录；
- 当前报销任务内按内容与实现版本绑定的文字观测缓存。

模块不拥有：用户确认、争议裁决、解析记录、已解析值、材料证据关联、费用事件、费用类别、候选明细或 ERP 行为。

## Image material types

v1 使用封闭 tagged union：

| 图片材料类型 | 字段候选 |
|---|---|
| `vat_invoice` | 隐藏技术身份发票号码、不含税金额、税额、价税合计 |
| `rail_ticket` | 隐藏技术身份、出行日期、出行时间、出行人、起点、终点、车次、席别、金额 |
| `road_passenger_ticket` | 票号、出行日期、出行时间、出行人、起点、终点、金额 |
| `ride_itinerary` | 出行人、合计金额、多段行程的日期、时间、城市、起点、终点、金额 |
| `hotel_folio` | 酒店、入住人、城市、入住日期、离店日期、合计金额 |
| `payment_slip` | 付款方、收款方、支付时间、交易号、金额 |
| `other_voucher` | 标题、商户、日期、金额 |

一张图片只能包含一份单据；行程单可以包含多个有票面顺序的行程段。检测到多份独立单据时返回 `multiple_documents`，不自动裁切。

## Candidate and evidence

每个适用字段必须是 `explicit`、`derived`、`ambiguous` 或 `missing`。可见值保留原文、确定性规范化建议和非空文字观测引用；`derived` 只允许版本化白名单规则，不能补全材料上不可见的业务事实。

文字观测包含原始文字、原图坐标、读取分数、适配器与模型来源。读取分数只用于复核和内部回退，不能改变材料证据状态或在冲突时自动选边。

## Implementation

```text
internal Skill
  -> TypeScript coordinator
       -> verify request and image bytes
       -> vision-direct (default) or one Python JSONL OCR Worker per batch
            -> RapidOCR or benchmark-only PaddleOCR
            -> text + polygon + score when OCR is selected
       -> typed field rules and deterministic validation
       -> task-local observation cache
       -> extracted | needs_model_vision | failed
  -> model vision only when requested by the coordinator
```

TypeScript 源码位于 `packages/image-field-extraction/`；Python 只实现 OCR Worker。内部 Skill 位于 `skills/extract-reimbursement-images/`，正常业务由 `baox` 给它版本化工单；Agent 不选择适配器或拼装低层命令。

模型视觉是宿主能力，不能由本地 TypeScript 直接调用。默认适配器直接由主会话逐张读取图片；选择 `ocr-assisted` 时，OCR 先产出候选，返回 `needs_model_vision` 或候选校验失败的图片再由内部 Skill 交给模型视觉，并把结果交回同一套校验。同一张图片一次只采用一条最终候选路径，识别完成后继续材料关联和 ERP 明细构造，用户在最终整单清单中统一确认。

## Runtime and distribution

- 首批平台：Apple Silicon macOS；RapidOCR PP-OCRv6 small 是性能验证后的默认候选，PP-OCRv6 medium
  只作为金标准确率挑战项，PaddleOCR 保留为对照；
- Python 基线：3.11，Skill 自建版本化虚拟环境；
- 安装入口：`baox-setup` 在材料解析前检查并安装固定版本，同时记录来源、体积和缓存位置；
- TypeScript 在发布前编译，用户不需要 TypeScript 工具链；
- 正式处理图片时只使用本地运行时和模型，不允许网络请求；
- 安装缺失或失败在 Setup 阶段明确阻塞；不能把环境问题伪装成图片证据不足。

## Validation

私有测试材料位于被 Git 忽略的 `resources/test-images/`。金标也留在本地；PaddleOCR、RapidOCR 和模型视觉独立产生候选，用户对照原图确认后才成为金标。仓库只提交合成 fixture、测试契约和脱敏汇总。

38 张现有材料先决定路线是否可行。某种图片材料类型至少有 5 张且关键字段已输出候选零错误，才对该类型默认启用 OCR；样本不足的类型继续默认走模型视觉。

排除首次安装和模型下载后的门槛：

- 冷启动不超过 15 秒；
- 热启动单图 p95 不超过 3 秒；
- 10 图批处理不超过 20 秒；
- 常见两图从工单到合法字段候选不超过 10 秒；
- Worker 峰值 RSS 不超过 2 GB；
- 处理图片期间无外连。

准确率分开统计已输出候选精确率和缺失率：关键字段错误输出比保守 `missing` 更严重。验证不能使用 OCR 自己的结果作为金标。
