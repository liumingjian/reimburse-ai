# 自己解 PDF 取字，不引入解析库，也不做 OCR

> **Status: superseded (2026-09-15, #197).** Superseded by ADR-0017: the app reads text PDFs with unpdf. `pdftext.mjs` survives only as `fixtures/scripts/pdftext.mjs`, which verifies the generated fixtures (#197). Paths below point into git commit `50931a3`, the last one that has the Skill-era code.

> **状态：重新采用（2026-09-11）。** 2026-09-09 曾被 [ADR-0011（MarkItDown）](0011-markitdown-agent-pdf-candidates.md)取代；[本地报销应用](../design/standalone-app.md)又把 `50931a3:kernel/src/pdftext.mjs` 定为文本 PDF 的首选取字来源，利用其逐项坐标做规则解析（须先在样本上验证，不通过时才改用受管 Python 中带坐标的解析器）。「Node 内核不内置 OCR；空文本 PDF 必须阻塞」继续有效。下文关于图片的修订注记已被 ADR-0004 的状态行取代。继任 ADR 待补。

发票事实提取的第一步是从 PDF 里取出票面文字。内核自带一个约 500 行的 PDF 取字实现（`50931a3:kernel/src/pdftext.mjs`）：全文扫描间接对象、展开对象流、用 Node 内建 `zlib` 解 `FlateDecode`、解析 `/ToUnicode` CMap、跟踪文本矩阵与图形矩阵，最后按坐标拼回行。

**内核自己不做 OCR。** PNG/JPG 以及取不出文字的扫描 PDF 一律落到 `needs_ocr` / `no_text`。

> **修订（2026-09-05）**：下面「图片发票一律阻塞、v1 不做 OCR」的结论已被 [ADR-0004](0004-vision-reads-images.md) 取代 ——
> 图片改由 Claude Code 自身的视觉能力读取，读数经内核结构校验和用户确认后成为事实。
> 本文关于空文本 PDF 不自动转视觉和 Node 内核不调用 OCR 的结论仍有效；文本 PDF 转换器与候选字段来源以 [ADR-0011](0011-markitdown-agent-pdf-candidates.md) 为准。

## Considered Options

- **依赖 `pdf-parse` / `pdfjs-dist`**：现成、健壮，但与 ADR-0002 的结论冲突 —— 内核必须零依赖，安装才能退化成纯文件拷贝（Claude Code 的 Skill 安装没有任何 postinstall，声明的 npm 依赖不会被安装）。一旦有依赖，离线分发就要求员工电脑能连 npm。
- **调用系统的 `pdftotext`（Poppler）**：研究阶段确实是这么验的，但它不在 macOS 默认安装里，等于把「不需要装任何东西」的承诺换成「需要 Homebrew」。
- **让模型读 PDF，把票面事实说出来**：PDF 的字节里本来就有确定答案，让模型去转述它，等于把一件确定的事换成一件不确定的事，没有任何好处。（图片没有这个确定答案，所以是另一回事 —— 见 ADR-0004。）
- **接入 OCR（本地模型或云服务）**：本地 OCR 要几百 MB 模型，云 OCR 要把发票原件发到外部服务。两者都超出 v1 的部署与隐私边界。

## Consequences

- **票面文字取得出来就有事实，取不出来就是阻塞。** 没有中间地带，也没有"确认继续"。这条把「解析失败」从一个技术错误变成了一个业务状态。
- **确定性解析只覆盖电子发票 PDF。** 已验证的 9 份真实样本里，7 份 PDF 全部解析成功，2 份 PNG 走 ADR-0004 的看图读取通道。两条路的产物形状相同，但来源强度不同：PDF 的字段直接来自文件字节，不需要用户确认；图片的字段来自一次看图读取，必须经用户确认才成为已解析值。
- **实现要对真实文件的怪癖负责。** 实测踩到并已修的四处：铁路电子客票的字体没有 `/ToUnicode`，编码是 GBK；AA 发票同样没有，编码是 UCS-2；行程单把每个表格单元格画成 `q cm BT..ET Q`，不跟踪图形矩阵就会把三段行程压成一行、行程段边界当场消失；AA 发票的字体把"电子"的"子"映射成康熙部首 `⼦`（U+2F26），因此所有文本匹配前必须做 NFKC 归一。这些都不是能靠读规范想出来的，只能靠真样本。
- **拼行靠估算字宽，可能差一个字形。** 逐字发字的发票（曹操样本）必须按字宽估算判断空格，估算在数字列上偶尔会把分隔位置挪一格。因此内核只提取**有标签锚定**的字段（发票号码、开票日期、合计、价税合计），不提取靠列位置切分的字段（如单价）。
- 有了这层，跨平台代价为零：同一份 `.mjs` 在 macOS 和 Windows 上行为一致，不受系统是否装了 Poppler 影响。
