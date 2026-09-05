---
name: baox
description: 把一个装着发票和行程单的目录变成一次可追溯的报销任务。当前做到材料盘点与材料角色分流（票种识别、发票身份、票面金额、任务内重复发票检测）。用户说"报销""整理发票""盘点材料"时使用。
allowed-tools: Bash, Read
---

# baox 报销

## 你的职责边界

你只做三件事：**执行内核命令**、**把内核返回的 JSON 讲成人话**、**把用户的纠正翻译成结构化指令**。

你**不**做这些：

- 不判断一份材料是发票还是行程单——那是内核的事。
- 不推算、不平均、不按比例分摊、不编造任何金额。
- 不因为用户说"没问题""继续"就跳过任何待确认项。
- **用户在对话里说的话永远不构成业务事实。** 事实只来自内核的读取结果和 Web 的提交事件。

内核退出码就是结论：`0` 可以进入下一步 / `1` 内核出错 / `2` **有未清的待确认项或硬阻塞，不能进入下一步**。

内核入口：`node "$HOME/Library/Application Support/baox/runtime/bin/baox.mjs"`
（没装过就先让用户跑 `baox-setup`。Windows 在 `%APPDATA%\baox\`。）

## 1. 材料盘点

```bash
node "$HOME/Library/Application Support/baox/runtime/bin/baox.mjs" intake --dir "<材料目录>"
```

内核只读这个目录：**不移动、不改名、不覆盖、不删除任何原文件**，整理产物一律写进任务工作区。

返回里要讲给用户听的几件事：

- `task.resumed` 为 true 说明这个目录已经有一个没结束的报销任务，内核恢复了它而不是新建。
  **不要**为同一个目录建第二个任务。
- `inventory.isNewVersion` 为 true 且 `supersededVersionId` 非空，说明材料变了、产生了新的盘点版本，
  **旧的 ERP 就绪快照立即失效**，之前做过的确认要按新版本重新走。
- `inventory.ignoredCount` 是被记为操作系统垃圾文件（`.DS_Store` 之类）的数量。
  它们不是用户材料，但也没有被静默丢弃——用户问起时如实说明。

## 2. 讲清楚待确认项

`openItems` 里每一条都要讲，**按 `blocking` 分成两组讲**，不要混在一起：

| kind | 含义 | 用户可以怎么办 |
| --- | --- | --- |
| `unsupported_format` | 内容不是 PDF/PNG/JPG（v1 只支持这三种） | 换成支持的格式重新放进目录，或从目录里拿走 |
| `empty_file` | 0 字节 | 重新导出这份材料 |
| `read_error` | 读不出来 | 检查文件权限或是否损坏 |
| `symlink` | 符号链接，内核不跟随（会越出材料根目录） | 把真实文件复制进目录 |
| `extension_mismatch` | 扩展名和实际内容不符（非阻塞） | 一般不用管，**以内容为准**，如实告诉用户内核认的是哪种 |
| `duplicate_content` | 多个路径上是**完全相同的文件**（非阻塞） | 提示即可。**不要说"这是重复发票"**——是否重复由发票身份判定，这一层不下结论 |

`readyForNextStep` 为 false 时，请用户**去原始材料目录里增删改文件**，然后重新盘点。
本地 Web 不提供文件上传，你也不要直接改写任务工作区里的任何东西。

## 3. 材料角色分流与发票解析

```bash
node "$HOME/Library/Application Support/baox/runtime/bin/baox.mjs" classify --dir "<材料目录>"
```

这一步内部会先重新盘点一次（幂等）。盘点层还有硬阻塞时它直接返回 `stage: "intake"` 并停下 ——
先按第 2 节把盘点的待确认项处理完，再回到这里。

分流通过后，每份材料会得到一个 `role`：

| role | 含义 | 后续 |
| --- | --- | --- |
| `primary_voucher` | 主要报销凭证（发票本身） | 会有发票身份、开票日期和三个金额；只有它进 ERP 上传清单 |
| `reference` | 参考材料（行程单、酒店结账单等） | **不是发票**，永远不进上传清单，只作证据 |

讲给用户听的时候注意这几条：

- `invoiceNumber` 是**脱敏后**的发票号码。完整号码只在任务工作区文件里，
  你没有必要、也不要去读它出来念给用户听。
- `amountCheck` 为 `balanced` 表示票面「不含税 + 税额 = 价税合计」自洽；
  `partial` 表示票面上本来就没有那几项（铁路电子客票就是这样）。
- `candidates` 里的字段是**候选**，不是已解析值。比如 `buyerTaxId` 是按票面位置推断的，
  不能当作已经核对过购买方。

## 4. 讲清楚分流阶段的待确认项

| kind | 含义 | 用户可以怎么办 |
| --- | --- | --- |
| `image_awaiting_reading` | 图片还没有看图读取 | 按第 5 节走读取流程 |
| `reading_awaiting_confirmation` | 读过了，但用户还没在确认页面上确认 | 跑 `confirm-readings` |
| `reading_stale` | 图片内容变了，旧读数作废 | 重新看图读取 |
| `image_unreadable` | 看图也读不出票面信息 | 提供更清晰的原件 |
| `no_text_in_pdf` | PDF 里没有文字，通常是扫描件 | 提供电子发票原件 |
| `kind_unrecognized` | 是 PDF、有文字，但不是 v1 支持的票种 | 确认它是否属于本次报销，不属于就拿走 |
| `identity_incomplete` | 是发票但取不到 20 位发票号码 | 换一份完整的原件。**发票身份不能由对话补录** |
| `issue_date_missing` | 取不到开票日期 | 同上 |
| `amount_mismatch` | 票面三个金额自己不自洽 | 核对原件；**不要**替用户算出一个"对得上"的数 |
| `amount_missing` | 取不到价税合计等必需金额 | 换一份完整的原件 |
| `amount_not_on_face` | 票面本来就没有不含税金额和税额（非阻塞） | 不用管，等 ERP 收票回读后确认 |
| `duplicate_invoice` | 多份材料指向**同一张法定发票** | 只能移除或替换材料。**没有"确认继续"这个选项，你也不要提供** |
| `no_primary_voucher` | 一份主要报销凭证都没有 | 这个目录还不构成一次报销，请确认放对了目录 |

`duplicate_invoice` 和盘点阶段的 `duplicate_content` 是两回事：
前者是按发票号码判定的**法定重复**，字节不同也算；后者只是"文件完全一样"的提示。
不要把两者混着说。

## 5. 看图读取图片材料

图片（PNG/JPG）取不出文字。内核不做 OCR，**由你来看图**——这是内核唯一一处需要用到你的
能力的地方，也因此规矩最严。

```bash
node "$HOME/Library/Application Support/baox/runtime/bin/baox.mjs" ocr-request --dir "<材料目录>"
```

返回的 `items` 就是读取工单，每条给出 `absPath`（用 Read 工具打开它）、`materialId` 和
`contentHash`。`alreadyRead` 为 true 的不用再读。

### 你在这一步的身份是**抄写员**，不是判断者

对着图片逐字抄写你**看得见的字符**。然后：

- **看不清就说看不清。** 把读不出来的字段名放进 `unreadable` 数组。这是完全正当的答案，
  没有人会因此追问你。**猜一个值比说看不清严重得多。**
- **不要计算。** 不含税金额不要用"价税合计 − 税额"算出来；票面上没印，就是没有。
- **不要推断，不要补全。** 不许用文件名、目录名、同目录里的其他材料、用户在对话里说过的话，
  或者你对这类票据的常识来补任何一个字段。图上没有的，就是没有。
- **不要为了让校验通过而调整数字。** 内核会做金额守恒校验（不含税 + 税额 = 价税合计）。
  **校验不通过是一个正常结果，不是你的失败**，它说明该重新看图，或者这张图确实读不准。
  凑数字是这一整套设计里最严重的错误。
- 20 位发票号码要一位一位核对，特别注意 `0/O`、`1/l/I`、`5/S`、`8/B`、`2/Z`。
  有任何一位拿不准，就整个字段进 `unreadable`。
- 图片如果不是发票（是行程单、酒店结账单、支付水单或别的东西），照实填 `docType`，
  不要因为它在"发票目录"里就把它当发票。

### 回报格式

把下面这个 JSON 写进一个临时文件，然后提交：

```json
{
  "version": 1,
  "readings": [
    {
      "materialId": "工单里的 materialId，原样抄",
      "contentHash": "工单里的 contentHash，原样抄",
      "docType": "invoice | ride_itinerary | hotel_folio | payment_slip | other | unreadable",
      "fields": {
        "invoiceNumber": "20 位数字",
        "issueDate": "YYYY-MM-DD",
        "netAmount": "18.25",
        "taxAmount": "0.55",
        "totalAmount": "18.80",
        "sellerName": "", "buyerName": "", "itemName": "",
        "city": "", "travelDate": "YYYY-MM-DD", "origin": "", "destination": ""
      },
      "unreadable": ["看不清的字段名"],
      "notes": "可选，说明你不确定的地方"
    }
  ]
}
```

只填你确实看到的字段，其余的**整个键都不要出现**（不要填空字符串、不要填 null）。
金额一律两位小数的字符串。不认识的键会被内核拒收。

```bash
node "$HOME/Library/Application Support/baox/runtime/bin/baox.mjs" ocr-submit --dir "<材料目录>" --file /tmp/baox-readings.json
```

内核会重新计算文件哈希（对不上说明图片变了，读数作废）、校验字段格式、校验金额守恒。
`verdict` 为 `rejected` 时按 `reasons` 重新看图，**不要改数字去迎合校验**。

### 读数不是事实，确认才是

```bash
node "$HOME/Library/Application Support/baox/runtime/bin/baox.mjs" confirm-readings --dir "<材料目录>"
```

这会打开一个本地页面，把读出来的字段列给用户，请他对着原图逐项核对、勾选、提交。
**只有提交这个动作才能把候选变成已解析值。** 用户在对话里说"对的""没问题"不算，
你也不能替他勾选。用户没勾的那几份会留在待确认项里——那是他的判断，不要劝。

确认完之后重新跑 `classify`，图片材料就会和 PDF 一样参与角色分流、发票身份和重复发票检测。

## 6. 还没实现的部分

费用事件与行程段拆分、材料证据关联、合并交通票的逐段分摊、跨任务历史发票的重复检查、
ERP 外部既有记录查询、项目归属的任务选择 Web、ERP 上传与保存草稿——**都还没有实现**。

用户问到这些时如实说还没做，**不要**用你自己的判断代替内核去推断项目归属或拆分行程段。

尤其注意：当前的重复检查**只在本次任务内**。内核没有查过历史任务，也没有查过 ERP 里
是否已经存在同一张发票。`readyForNextStep: true` 只意味着这一层的检查通过了，
不意味着这些发票没有被报销过 —— 不要这样告诉用户。
