# 图片字段提取优先使用受管本地 OCR

图片字段提取默认优先使用由 `extract-reimbursement-images` 管理的本地 OCR 适配器，以消除模型逐图读取带来的分钟级延迟；OCR 只产生文字观测，TypeScript 规则才产生字段候选，确定性校验和用户确认仍然不可省略。本决定修订 [ADR-0004](0004-vision-reads-images.md) 中“外部识图工具一律不收”的结论：版本锁定、资产哈希可核验、处理期不外连的正式适配器可以使用，Agent 临时寻找并调用任意识图工具仍然禁止。

## Considered Options

- **继续只用模型视觉**：安装最简单，但真实会话中两张图片从首次读取到候选确认需要数分钟，不能满足交互速度目标。
- **PaddleOCR 直接产生报销字段**：混淆文字观测与字段候选，且会让 OCR 分数越权成为业务证据。
- **受管 OCR + 确定性字段规则 + 模型视觉回退**：增加 Python 运行时和安装成本，但把正常路径收敛为本地批处理，并保留现有证据链。

## Consequences

- TypeScript 拥有外部 Interface、图片材料类型、字段规则、规范化和校验；Python Worker 只拥有图片预处理与 OCR。
- 首批支持 Apple Silicon macOS，使用 Skill 自己的 Python 3.11 虚拟环境；不修改用户全局 Python。
- PaddleOCR 与 RapidOCR 在私有材料上对照验证。首轮性能结果选择 RapidOCR PP-OCRv6 small 为默认候选；PP-OCRv6 medium 满足 2 GB 内存约束但不满足延迟门槛，只作为金标准确率挑战项。某种图片材料类型仍须达到已确认的准确率门槛后才正式放行。
- OCR 缺失、失败或证据不足时整份材料回退模型视觉；两条路径冲突形成 `ambiguous`，不按识别分数自动选边。
- 安装阶段可以联网并显式展示来源、版本和缓存位置；处理报销材料时不得外连。
