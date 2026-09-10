# MarkItDown 报销材料解析评估

日期：2026-09-09。状态：用户已接受文本 PDF 主路径；本地生产接线及锁定运行时已实现，真实材料验证见[迁移验收记录](../qa/markitdown-pdf-2026-09-09.md)。尚未合并、安装或发布。

## 结论

采用 `原始 PDF -> MarkItDown Markdown -> Agent 字段候选 JSON -> 确定性校验 -> 分类明细确认` 作为文本 PDF 主路径，并以真实材料完成迁移验收（决策见 ADR-0011）。MarkItDown 负责转换，Agent 负责理解字段，内核继续负责身份、金额、日期、材料关联、范围和放行。Markdown 是原件的派生产物，不能成为新的原始材料。

实测支持该方向，但不支持“转换成功且 JSON 合法就可进入 ERP”的简化版本。当前样本的 Markdown 表格会断裂、串列；第一次盲测的业务值正确，证据行号却有错误。固定模板必须连同证据校验一起设计。

## 环境与方法

- 使用用户已有 `/Users/lmj/temp/test-doc2md/.venv`，Python 3.13.11，MarkItDown 0.1.7；未安装或升级依赖。
- 使用本地 CLI 默认 PDF 转换器，未启用插件、Azure 或额外模型接口。安装源码的 PDF 实现使用 pdfplumber 和 pdfminer，默认路径不做扫描件 OCR。
- 实际转换 9 份 PDF：两张历史普通发票、两张多段行程单、曹操主发票及单段行程单、酒店发票及水单、铁路客票。另转换真实 `fengyun-1.png` 检查图片边界。
- 多行程已报销样本只作解析 QA；未写 ERP、未修改原件或报销任务。
- 派干净上下文的 `gpt-5.6-luna / max` 代理，仅读取 Markdown 填写固定形状 JSON。该代理不访问 PDF、图片、仓库或其他答案。主窗口再对照原 PDF 渲染图及已核实事实检查。

复现命令示例：

```sh
/Users/lmj/temp/test-doc2md/.venv/bin/markitdown \
  '/Users/lmj/repos/reimburse-ai/resources/expired/【高德打车-191.69元-4个行程】高德打车电子行程单.pdf' \
  -o /tmp/baox-markitdown-root/191-itinerary.md
```

## 实测结果

| 对象 | 结果 | 解释 |
| --- | --- | --- |
| 9 份文本 PDF | 9/9 转换退出码为 0，检查的关键文字保留 | 合计约 12.91 秒，单文件约 1.09-3.55 秒；不代表任意 PDF 的准确率 |
| 116.32 元、5 段行程单 | 五段文字、日期、城市、金额保留；仅 4/5 段表现为完整 Markdown 表格行 | 第三段变成普通文本，不能只用 Markdown 表格解析器取记录 |
| 191.69 元、4 段行程单 | 四段文字及跨行地址片段保留；表格和普通文本混合 | 前两段酒店地址和第四段起终点被拆散，表头列位置并不始终可靠 |
| 四段行程 Markdown 盲抽取 | 四段日期、时间、城市、起点、终点、金额均与原件一致；合计 191.69 元 | Agent 报告了跨行归并歧义，因此不能静默当成确定性解析事实 |
| 第一轮证据引用 | 第 2、4 段的引用行集合不含该段日期和金额 | JSON 语法有效且业务值正确，仍不能算证据检查通过；原结果保留未修饰 |
| 曹操主发票 Markdown 盲抽取 | 发票号码、开票日、净额 50.12、税额 1.51、合计 51.63 正确 | 未把折扣前明细金额当合计；发票代码和空白出行日期保持 null |
| 第二轮证据引用 | 曹操五个非空字段的行号及原文片段均通过逐行检查 | 读取时提供真实行号，输出后由代码核验 quote 确实存在 |
| 酒店、铁路及历史普通发票 | 检查的日期、号码、合计文字均保留 | 水单标签和值可被分隔为空行；铁路原件没有净额、税额，不能由模型反算 |
| 默认转换真实 PNG | 退出码 0，但输出仅一个换行字节 | 退出码不能作为材料可用判据；普通图片仍需现有视觉读取路径 |

全部 PDF 样本带文字层。本轮未覆盖真实扫描 PDF、多页混合 PDF、密码保护 PDF 或多次独立模型抽取的一致性，不能宣称这些场景已验收。部分输出只因原件印有“第 1 页”而出现页码；MarkItDown 默认产物没有统一的页码和坐标证据接口。

## 推荐的闭环

1. 内核读取原件并固定 `materialId/contentHash` 和任务材料范围。已报销且仅作 QA 的文件继续按明确排除记录处理。
2. 本地转换器生成 Markdown；内核记录工具及依赖锁定版本、参数、原件哈希、Markdown 哈希。空产物、转换失败或缺少必要内容形成明确待办。
3. 给宿主 Agent 提供带稳定行标识的 Markdown 和封闭 JSON Schema。Agent 只提出字段候选，不自报“已解析、已确认、可写 ERP”。不额外在转换器内配置一个模型客户端。
4. 每个候选值提供原文片段及行标识。跨行字段允许引用多个片段，并明确归并依据；不能确定时保留 null 和待确认项。元数据中的哈希、工具版本由内核填写，不由模型声称。
5. 内核校验 JSON 结构、额外字段、原件及 Markdown 哈希、引用片段、金额精度和守恒、真实日期、声明段数、逐段合计及发票身份。原文引用存在也不证明语义解释一定正确，仍需后续确认；金额守恒不能证明起终点没有互换。
6. 复用现有分类明细确认，再进入本人项目簿选择与 ERP 就绪检查。不能因来源为 PDF 就把 Agent 提取结果标成 `kernel` 来源并免除候选确认。
7. Markdown 缺字、字段冲突或跨行归属不可靠时，回看原始 PDF 的渲染页。仍不能确定则补充或排除，不补造值；默认不接入额外云 OCR。

## JSON 模板边界

以下保留评估时的结构提案；生产接口以 [Schema](../../kernel/src/pdf-markdown-schema.json) 和内核生成的材料工单为准。公共信封按 `invoice / ride_itinerary / hotel_folio` 区分字段集合，禁止未声明字段。模型不能自行填写权威元数据：

```json
{
  "schemaVersion": 1,
  "materialId": "由内核填入",
  "contentHash": "原件哈希，由内核填入",
  "source": {
    "kind": "agent_from_markdown",
    "converter": "markitdown",
    "converterVersion": "由内核填入",
    "markdownHash": "由内核填入"
  },
  "documentType": "ride_itinerary",
  "fields": {},
  "segments": [],
  "fieldEvidence": {},
  "fieldStatus": {},
  "unreadable": [],
  "issues": []
}
```

- 发票字段：原生发票代码及号码、开票日期、不含税金额、税额、价税合计；费用发生日期与开票日期分开。
- 行程单字段：声明段数和合计；每段独立索引、发生日期、时间、城市、起点、终点及票面可见的段金额。
- 水单字段：入住日期、离店日期、消费合计；地区如仅从店名推断，必须标为推导候选，不能伪装成带字段标签的票面事实。
- 证据状态沿用现有 `explicit / derived / ambiguous / missing`。`unreadable` 不能用来掩盖整份转换为空；缺字段不填零。
- 金额沿用两位小数字符串，内核转整数分校验；逐段税额分摊留给已有确定性规则，不由 Agent 计算。
- 证据使用绑定 Markdown 哈希的行标识及精确 quote；页码只有可验证时才填写。首轮盲测证明不能相信模型手数的行号。
- 不把该接口冒充 `vision.ingestReadings`：Markdown 抽取没有视觉 `sighted.shape` 语义。适配后仍进入现有分类、关联及校验模块，保留真实来源。

## 决策与迁移

推荐把文本 PDF 的主路径迁移到 MarkItDown 加 Agent 候选提取，而非长期维护两套并列的权威解析器。现有实现可保留作迁移期真实样本对照，全部约定场景验收后再移除被替代部分。PNG/JPG 及没有可靠文字的材料保留视觉证据路径。

该选择由 [ADR-0011](../adr/0011-markitdown-agent-pdf-candidates.md) 取代 [ADR-0003](../adr/0003-zero-dependency-pdf-text.md) 的文本 PDF 主路径：Node 内核仍无 npm 依赖，但需要锁版本的 Python/uv MarkItDown 运行时；模型提取 PDF 字段必须走候选确认。当前机器的临时虚拟环境可用于评估，生产不能硬编码 `/Users/lmj/temp/test-doc2md`。

用户已接受上述主路径和运行时依赖；生产 lockfile、安装/发布接线、空文本与候选 JSON 内核接收仍须完成后才能宣称迁移验收。

另有既存文档差异：ADR-0005/CONTEXT 的逐段金额必须由用户给出，与当前 main 在参考段金额精确守恒时自动采用的行为不同。此次转换评估没有改变分摊规则；后续迁移规格应明确沿用已确认的业务规则，不能借换工具改变金额来源或放行标准。

## 证据位置

- 转换清单：`/tmp/baox-markitdown-eval/manifest.json`。
- 转换质量记录：`/tmp/baox-markitdown-eval/evaluation.md`。
- 首轮盲抽取：`/tmp/baox-markitdown-root/191-extracted.json`，保留错误证据行号，未事后修饰结果。
- 第二轮盲抽取：`/tmp/baox-markitdown-root/cao-invoice-extracted.json`。
- 原件视觉对照：`/tmp/baox-expired-qa/116-itinerary.png`、`/tmp/baox-expired-qa/191-itinerary.png`。
- 上游说明：[Microsoft MarkItDown](https://github.com/microsoft/markitdown)。官方将其定位为供 LLM 和文本分析使用的 Markdown 转换工具，并非高保真排版转换器；默认转换与可选 OCR/云端组件有明确区别。
