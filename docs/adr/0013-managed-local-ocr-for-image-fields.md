# 图片字段提取 Adapter：默认模型视觉，可选受管本地 OCR

> **Status: superseded (2026-09-15, #197).** Superseded by ADR-0017 and slice #186: OCR runs in process (`onnxruntime-node`, `server/src/parse/ocr.ts`), with no Python worker and no model vision; `50931a3:packages/image-field-extraction` was deleted in #197. Paths below point into git commit `50931a3`, the last one that has the Skill-era code.

> **状态：已修订（2026-09-11）。** 本文原编号 0011，与 MarkItDown 那篇撞号，改为 0013。[本地报销应用](../design/standalone-app.md)把「受管 OCR + TypeScript 规则」定为唯一的图片路径：失败转手工补填，不再有模型视觉默认路径或视觉回退；OCR 运行时归应用所有，不再是「Skill 自己的虚拟环境」。Python 只做预处理与 OCR、TypeScript 规则产生候选、受管 RapidOCR 继续有效。

图片字段提取默认使用 `vision-direct`，直接调用模型自身的视觉能力；`extract-reimbursement-images` 提供可切换的 `ocr-assisted` 适配器，在需要时先批量运行受管本地 OCR，再把缺字段或校验失败的候选交给模型视觉。OCR 只产生文字观测，TypeScript 规则才产生字段候选，确定性校验和最终整单明细确认仍然不可省略。本决定修订 [ADR-0004](0004-vision-reads-images.md) 中“外部识图工具一律不收”的结论：版本锁定、资产哈希可核验、处理期不外连的正式适配器可以使用，Agent 临时寻找并调用任意识图工具仍然禁止。

## Considered Options

- **继续只用模型视觉**：当前准确度较好、安装最简单，是默认路径；代价是批量图片读取时间可能更长。
- **PaddleOCR 直接产生报销字段**：混淆文字观测与字段候选，且会让 OCR 分数越权成为业务证据。
- **受管 OCR + 确定性字段规则 + 模型视觉回退**：作为可选 Adapter 增加 Python 运行时和安装成本，但保留后续替换 OCR 的接口和回退能力。

## Consequences

- TypeScript 拥有外部 Interface、图片材料类型、字段规则、规范化和校验；Python Worker 只拥有图片预处理与 OCR。
- 首批支持 Apple Silicon macOS，使用 Skill 自己的 Python 3.11 虚拟环境；不修改用户全局 Python。
- PaddleOCR 与 RapidOCR 在私有材料上对照验证。首轮性能结果选择 RapidOCR PP-OCRv6 small 为默认候选；PP-OCRv6 medium 满足 2 GB 内存约束但不满足延迟门槛，只作为金标准确率挑战项。某种图片材料类型仍须达到已确认的准确率门槛后才正式放行。
- OCR 证据不足或单图识别失败时，该图片回退模型视觉；受管运行时缺失或损坏由 Setup 明确阻塞，不能静默降级。两条路径都只产生候选，先进入分类和费用事件，最终由用户在整单 ERP 明细清单中统一确认。
- 发票 OCR 候选必须具备隐藏技术身份和不含税金额、税额、价税合计；开票日期和开票方不是业务必需字段。V1 多页发票直接形成阻塞，要求排除或替换。
- 安装阶段可以联网并显式展示来源、版本和缓存位置；处理报销材料时不得外连。
