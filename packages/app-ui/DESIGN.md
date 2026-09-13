---
version: beta
name: baox-standalone-app
description: "本地报销应用（docs/design/standalone-app.md）的视觉基础，分两层。品牌层取自 Linear：单一薰衣草蓝强调色、8px 控件与 12px 面板圆角、600/500/400 字重、无投影无渐变。产品层取自 IBM Carbon：按页面类型决定宽度（表格页铺满主区）、按层级语义排表面（着色框架 → 白色工作面 → 表头与悬停层）、productive 字阶、数据表格的工具栏与行高档位、带文字的低饱和状态色、官方图标库。"

sources:
  - slug: linear.app
    file: ../../prototypes/design-md/linear.app.DESIGN.md
    role: 品牌层（强调色、圆角、字重、无投影）
  - slug: ibm
    file: ../../prototypes/design-md/ibm.DESIGN.md
    role: 产品层（密度、宽度、分隔方式、单一强调色、hairline）
  - slug: carbon
    file: https://carbondesignsystem.com
    role: 产品层细节（UI shell、data table、tag、notification、spacing、type sets productive、Gray 10 主题的 layer 语义）
  - slug: airtable
    file: ../../prototypes/design-md/airtable.DESIGN.md
    role: 历史来源（表单密度），已被 Carbon 取代的部分见正文
fetched: 2026-09-13
command: "npx getdesign@latest add <slug>"

colors:
  primary: "#5e6ad2"
  primary-hover: "#4f5bc4"
  primary-pressed: "#4551b3"
  primary-soft: "#eef0fb"
  on-primary: "#ffffff"
  focus-ring: "rgb(94 106 210 / 40%)"
  frame: "#eff1f4"
  layer-1: "#ffffff"
  layer-2: "#f6f7f9"
  layer-hover: "#eef0f4"
  layer-selected: "#eef0fb"
  border-subtle: "#e3e5e8"
  border-strong: "#c9cdd3"
  canvas: "#f6f7f7"
  surface-1: "#ffffff"
  surface-2: "#f5f6f6"
  surface-3: "#eeeff1"
  hairline: "#e3e5e8"
  hairline-strong: "#cfd2d7"
  ink: "#17181c"
  ink-muted: "#4b4f57"
  ink-subtle: "#8a8f98"
  ink-tertiary: "#b1b5bd"
  info: "#2f5fb3"
  info-soft: "#e8effa"
  success: "#1f8a3a"
  success-soft: "#e6f5ea"
  warning: "#9a5b00"
  warning-soft: "#fff3dc"
  danger: "#b3392f"
  danger-soft: "#fbe9e7"
  neutral-soft: "#eceef1"
  overlay: "rgb(23 24 28 / 40%)"

typography:
  page-title:
    fontFamily: text
    fontSize: 28px
    fontWeight: 600
    lineHeight: 1.29
    letterSpacing: -0.4px
  section:
    fontFamily: text
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: -0.2px
  heading-sm:
    fontFamily: text
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.375
    letterSpacing: 0
  body-01:
    fontFamily: text
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.43
    letterSpacing: 0.16px
  body-strong:
    fontFamily: text
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.43
    letterSpacing: 0.16px
  body-compact:
    fontFamily: text
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.38
    letterSpacing: 0.16px
  label:
    fontFamily: text
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.33
    letterSpacing: 0.32px
  table-head:
    fontFamily: text
    fontSize: 13px
    fontWeight: 600
    lineHeight: 1.38
    letterSpacing: 0.16px
  metric:
    fontFamily: text
    fontSize: 24px
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: -0.3px
  code:
    fontFamily: mono
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.38
    letterSpacing: 0
  title:
    fontFamily: text
    fontSize: 22px
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: -0.4px
  headline:
    fontFamily: text
    fontSize: 17px
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: -0.2px
  body:
    fontFamily: text
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0
  caption:
    fontFamily: text
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: 0
  button:
    fontFamily: text
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: 0
  mono:
    fontFamily: mono
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0

fonts:
  text: '-apple-system, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif'
  mono: '"SF Mono", Menlo, "JetBrains Mono", ui-monospace, monospace'

rounded:
  xs: 4px
  md: 8px
  lg: 12px
  pill: 9999px

spacing:
  xxs: 4px
  xs: 8px
  sm: 12px
  md: 16px
  lg: 24px
  xl: 32px
  xxl: 48px

layout:
  form-max-width: 720px
  page-gutter: 24px
  page-gutter-wide: 32px
  frame-gap: 8px
  table-row-compact: 32px
  table-row: 40px
  table-row-tall: 48px
  toolbar-height: 48px
  action-bar-height: 64px
  icon-size: 16px
  progress-height: 4px
  progress-width: 96px
  search-width: 280px
  tooltip-max-width: 280px
  hairline-width: 1px
  focus-ring-width: 2px
  control-height-sm: 28px
  control-height-lg: 44px
  stage-index-size: 20px
  stage-bar-width: 2px
  page-min-width: 320px
  dropzone-min-height: 200px
  file-size-width: 72px
  split-list-width: 300px
  pending-side-width: 400px
  assign-table-min-width: 880px
  dialog-width: 440px
  dialog-wide-width: 720px
  checkbox-size: 16px
  print-page-min-width: 280px
  crop-editor-width: 480px
  crop-handle-size: 18px

components:
  app-frame:
    backgroundColor: "{colors.frame}"
    gap: "{layout.frame-gap}"
  work-surface:
    backgroundColor: "{colors.layer-1}"
    border: "1px {colors.border-subtle}"
    rounded: "{rounded.lg}"
    gutter: "{layout.page-gutter}"
    gutterWide: "{layout.page-gutter-wide}"
  data-table-toolbar:
    backgroundColor: "{colors.layer-1}"
    height: "{layout.toolbar-height}"
    borderBottom: "1px {colors.border-subtle}"
  data-table-header:
    backgroundColor: "{colors.layer-2}"
    textColor: "{colors.ink-muted}"
    typography: "{typography.table-head}"
    height: "{layout.table-row}"
    borderBottom: "1px {colors.border-subtle}"
  data-table-cell:
    typography: "{typography.body-01}"
    paddingX: "{spacing.sm}"
    height: "{layout.table-row}"
    divider: "1px {colors.border-subtle}"
    hover: "{colors.layer-hover}"
    selected: "{colors.layer-selected}"
  batch-action-bar:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    height: "{layout.toolbar-height}"
  status-tag:
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: 2px 8px
    gap: "{spacing.xxs}"
  overview-strip:
    backgroundColor: "{colors.layer-1}"
    divider: "1px {colors.border-subtle}"
    typography: "{typography.metric}"
  action-bar:
    backgroundColor: "{colors.layer-1}"
    borderTop: "1px {colors.border-subtle}"
    height: "{layout.action-bar-height}"
  tooltip:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.xs}"
    maxWidth: "{layout.tooltip-max-width}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: 8px 14px
    minHeight: 36px
  button-secondary:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.ink}"
    border: "1px {colors.hairline-strong}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: 8px 14px
    minHeight: 36px
  button-tertiary:
    backgroundColor: transparent
    textColor: "{colors.ink-muted}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: 8px 10px
  text-input:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.ink}"
    border: "1px {colors.hairline-strong}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: 8px 12px
    height: 36px
  panel:
    backgroundColor: "{colors.surface-1}"
    border: "1px {colors.hairline}"
    rounded: "{rounded.lg}"
    padding: 20px
  data-table-row:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    padding: 10px 12px
    divider: "1px {colors.hairline}"
  status-badge:
    backgroundColor: "{colors.surface-3}"
    textColor: "{colors.ink-muted}"
    typography: "{typography.caption}"
    rounded: "{rounded.pill}"
    padding: 2px 8px
  step-bar:
    markerSize: 24px
    markerBorder: 1px
    connectorWidth: 2px
    connectorMinWidth: 16px
    taskWidth: 260px
    taskMinWidth: 120px
  top-bar:
    backgroundColor: "{colors.frame}"
    height: 48px
---

## 用途

这份文件是 `@baox/app-ui` 所有页面的视觉依据，也是唯一的样式来源。改动页面样式前先改这里，然后运行
`pnpm --filter @baox/app-ui tokens`：`scripts/build-tokens.mjs` 会把 front matter 生成为
`src/styles/tokens.css` 里的 CSS 自定义属性。页面 CSS 只允许引用这些自定义属性，不写字面颜色、字号、圆角和尺寸。

命名规则：`colors.x` 生成 `--color-x`，`fonts.x` 生成 `--font-x`，`typography.x` 生成 `--text-x-size` /
`-weight` / `-line` / `-tracking` / `-family` 以及可直接用于 `font:` 的 `--text-x`，`rounded.x` 生成 `--radius-x`，
`spacing.x` 生成 `--space-x`，`layout.x` 生成 `--layout-x`，`components.name.prop` 生成 `--name-prop`（prop 转 kebab-case），
其中 `{group.key}` 形式的引用会解析成 `var(--…)`。

getdesign 原件（linear.app、ibm、airtable）存放在 `prototypes/design-md/`，逐字保留，用于溯源；本文件只写本项目用到的部分，以及与原件不同之处的理由。
静态效果图在 `prototypes/carbon-b/`（`tasks.html`、`review.html`），直接引用本文件生成的 `tokens.css`，是这一版规则的样张。

## 为什么改版（方案 B）

用户两轮评审的原话："界面设计太过简陋，比不上商业化产品"；"特别不喜欢留白……明明有多余的空间可用，为何要挤到一个狭小空间左右拖拉表格"。
逐条对应到上一版规则里的原因：

- `content-max-width: 1200px` 是 Linear 营销站的阅读宽度，搬进产品后在 1792px 的窗口上空出约 500px，13 列的整单明细表却被迫横向滚动。
- 反转成浅色时 Linear 的表面阶梯塌了：canvas #f6f7f7 与 surface-2 #f5f6f6 几乎一样，灰底上一排同样的白卡片，没有层级。
- 日期、金额、No. 全用等宽字体，读起来像调试界面；标题 22px 直接跳到正文 14px，没有节奏。
- 没有图标、没有状态色、没有概览。Linear 的"产品感"来自它的产品界面（密集的行、状态图标、着色侧栏、行悬停），而 getdesign 的 Linear 原件只记录了营销站。

所以分两层：**品牌层**继续用 Linear（让它仍然是这个应用），**产品层**换成 IBM Carbon（它记录的恰恰是企业产品界面）。
IBM 原件的关键一句："Content is dense by design — IBM's customers expect to see a lot on a page, not a lot of air." 报销核对是同一类工作。

## 品牌层：从 Linear 保留什么

- **单一强调色**：`{colors.primary}` 薰衣草蓝 #5e6ad2，悬停 #4f5bc4，按下 #4551b3。只用于主按钮、焦点环、当前导航项、选中行与批量操作栏、链接强调。不做装饰底色。
- **圆角**：按钮和输入 8px，面板与工作面 12px，小标签与提示 4px，状态标签 pill。**不采用** Carbon 的 0px 直角，这是两层之间唯一刻意保留的品牌差异。
- **字重**：600 标题、500 按钮与强调、400 正文。不用 700，也不用 IBM 的 300 细体大字（那是 Plex 的营销签名，中文字体下发虚）。
- **无投影、无渐变、无光晕**：层级只靠表面色与 1px 边线（IBM 原件同样如此："Card hierarchy is carried by 1px hairlines and surface change, never by drop shadow"）。唯一例外是弹层遮罩 `{colors.overlay}`。
- 一屏一个主按钮；不用 em-dash 和 en-dash；标题前不加小字眉题。

## 产品层：从 Carbon 借什么

### 宽度按页面类型定

Carbon 的 UI shell 与 data table 默认铺满可用宽度，只有表单和长文字才限宽。

| 页面类型 | 宽度 | 例子 |
| --- | --- | --- |
| 表格页、核对页、左右分栏页 | 铺满主区，不设最大宽 | 任务列表、整单明细确认、盘点、待确认项、对账、打印稿预览 |
| 表单页、说明文字 | 最大 `{layout.form-max-width}` 720px | 新建任务、设置、启动页 |

页面左右内边距 `{layout.page-gutter}` 24px，主区宽于 1584px（Carbon max 断点）时用 `{layout.page-gutter-wide}` 32px。
上一版的 `content-max-width` 1200px 已在改版时删除：工作面本身不限宽，表单与说明文字在工作面里自己限到 720px。
表格、摘要条、工具栏、操作栏在工作面里通栏（贴到工作面左右边线），首列与末列用页面内边距留白，所以首列文字仍与标题对齐。

### 表面按层级语义排（Carbon Gray 10 的 layer 思路）

| 层 | token | 用在哪 |
| --- | --- | --- |
| 框架 | `{colors.frame}` #eff1f4 | 顶栏、侧栏、工作面四周的 `{layout.frame-gap}` 8px 缝 |
| 工作面 layer-1 | `{colors.layer-1}` 白 | 主区：一整块 12px 圆角、1px 边线的白色工作面，页面内容都在它里面 |
| layer-2 | `{colors.layer-2}` #f6f7f9 | 白色工作面内部的抬升层：表头、摘要行、工具栏里的分段控件底 |
| 悬停 | `{colors.layer-hover}` #eef0f4 | 表格行悬停、三级按钮悬停、侧栏链接悬停 |
| 选中 | `{colors.layer-selected}` #eef0fb | 选中的行（与 primary-soft 同值） |
| 弹层 | `{colors.layer-1}` + `{colors.overlay}` 遮罩 | 对话框 |

决定与理由：**顶栏和侧栏用同一个着色框架，主区是一整块白色工作面**。这是 Linear 桌面产品的做法（导航在浅灰框架里，工作内容在一张白纸上），
也对得上 Carbon 的"layer 在 background 之上"的语义。上一版是灰底主区上摆一排白卡片，卡片和底色几乎同色；现在只有一张纸，
纸里用 layer-2 分出表头与摘要，不再用卡片套卡片。顶栏不做 Carbon 的深色 Gray 100 页头：旁边永远是白底票据与打印稿，深色页头会抢走注意力。

### 字阶（Carbon productive type set）

| token | 规格 | 用途 |
| --- | --- | --- |
| `{typography.page-title}` | 28px / 600 / -0.4px | 页面标题，一页一个 |
| `{typography.section}` | 20px / 600 | 页面内的节标题 |
| `{typography.heading-sm}` | 16px / 600 | 工具栏标题、侧栏任务名、对话框标题 |
| `{typography.body-01}` | 14px / 400 / +0.16px | 正文与表格单元格（Carbon body-01） |
| `{typography.body-strong}` | 14px / 500 | 表格里的主列（任务名）、金额总额 |
| `{typography.body-compact}` | 13px / 400 / +0.16px | 只给 10 列以上的宽表单元格（整单明细确认的 13 列表）：在 1440px 窗口、侧栏展开时也放得下，不必横向滚动 |
| `{typography.table-head}` | 13px / 600 / +0.16px | 表头 |
| `{typography.label}` | 12px / 400 / +0.32px | 标签、说明、状态标签（Carbon label-01） |
| `{typography.metric}` | 24px / 500 | 概览条里的计数 |
| `{typography.code}` | 13px 等宽 | 只给标识符 |

旧的 `title`、`headline`、`body`、`caption`、`mono` 保留给现有页面，改版时换成上表。

**数字用正文字体加 `tabular-nums`**：日期、时间、金额、No.、计数都用正文字体，打开 `font-variant-numeric: tabular-nums` 让位数对齐，金额右对齐。
**等宽字体只给标识符**：发票代码与号码、草稿号（BX…）、费用项目编码（FY…）、内容哈希。上一版把日期和金额也设成等宽，是"像调试界面"的主要原因之一。

### 数据表格（Carbon data table）

- **工具栏**在表格上方，高 `{layout.toolbar-height}`：左边是表名和条数，接着是搜索框（`{layout.search-width}`）与状态筛选（分段控件），右边放表级动作。页面主按钮留在页头，不进工具栏。
- **表头**在 layer-2 上，`{typography.table-head}` 13px 600，`{colors.ink-muted}`；不画列线，只有 1px 行分隔线。
- **行高三档**：紧凑 `{layout.table-row-compact}` 32px（盘点材料清单这类长列表）、默认 `{layout.table-row}` 40px（整单明细确认）、宽松 `{layout.table-row-tall}` 48px（任务列表，每行有进度条与操作）。
- 行悬停 `{colors.layer-hover}`；选中行 `{colors.layer-selected}`；有行被选中时，工具栏换成强调色的**批量操作栏**（`{components.batch-action-bar}`），显示"已选 N 项"和批量动作，取消后恢复工具栏。
- **列宽按内容定**：编码、日期、金额、No. 这类短列 `nowrap` 并按内容收紧；项目、费用项目、说明这类长文字列吸收剩余宽度并允许换行
  （中文 `word-break: keep-all`，只在「编码 / 名称」之间断开，不在词中间断）。
- **有空间就铺满，没空间就横向滚动（用户要求）**：每张宽表（整单明细确认、任务列表、回读与对账、项目归属、个人项目簿）都放在一个
  `overflow-x: auto` 的通栏容器里，表格 `width: 100%` 铺满。表格的最小宽度就是各列按内容收紧后的宽度之和：
  窗口比这更窄时整张表横向滚动，**不再继续挤压列宽**，文字不会被挤成一字一行。
  横向滚动时，标识列固定在左（No.，没有 No. 的表是任务名 / 项目号），收尾列固定在右（总额；任务列表是操作列），
  固定列带与所在行相同的底色和一条 1px 分隔线；表头仍在 layer-2 上、不折行，滚动时照常可读。
  13 列的整单明细表在 1440px 与 1792px 的窗口上（侧栏展开）**不得横向滚动**；1100px 左右的窗口会滚动，这是预期的退路。
- 金额列右对齐、`tabular-nums`；动作列 `nowrap`，永远不折行；限制说明（如"不能作废"）放进提示（tooltip）或次级小字，不在单元格里挤一段话。
- 同一分类内与上一行相同的文字单元格变淡（值照常在），金额列不变淡。**整单明细表不分组、不画组标题、不算合计**：页面不计算任何数，只显示服务端给出的价税合计。

### 状态色（放宽"只用单色"）

上一版规定状态只用一种颜色，结果任务列表里所有状态看起来一样。改为 Carbon tag 的做法：状态标签可以用低饱和的语义色，**但永远配文字标签**，颜色只是第二通道。

| 语义 | 前景 / 底色 | 用法 |
| --- | --- | --- |
| 进行中 | `{colors.info}` / `{colors.info-soft}` | 任务在主线上推进 |
| 完成 | `{colors.success}` / `{colors.success-soft}` | 已交接、校验通过、ERP 回读一致 |
| 需要注意 | `{colors.warning}` / `{colors.warning-soft}` | 对账中、待确认项、缺支付截图、回读需人工核对 |
| 错误 | `{colors.danger}` / `{colors.danger-soft}` | 校验不通过、写入中止、原件缺失 |
| 中性 | `{colors.ink-muted}` / `{colors.neutral-soft}` | 草稿、未开始、已作废 |

`{colors.info}` 是偏灰的蓝，与强调色薰衣草蓝明显不同，只出现在状态标签与进度条里，不做按钮与链接，所以不算第二强调色。
状态标签是 pill，左侧一个 16px 状态图标加文字；不用裸彩色圆点。

### 图标

允许图标，但只用**一个官方图标库：IBM Carbon Icons（`@carbon/icons`，Apache-2.0）**，从不手绘路径。
应用里不加依赖：`src/shell/Icon.tsx` 收录用到的少数几个图标，路径数据从 `@carbon/icons@11.88.0` 的 `svg/16`、`svg/32` 逐字复制
（与静态效果图同一份），每个图标注明来源文件；页面只写 `<Icon name="…" />`。要新图标时从同一个包、同一个版本复制，不自己画。
图标尺寸 `{layout.icon-size}` 16px，颜色跟随文字（`fill: currentColor`）。只在三类地方用：状态标签与侧栏步骤、工具栏（搜索、筛选）、按钮前缀（最多一个）。按钮文字后不加箭头"→"。

### 页面操作栏

需要"整页确认"的页面（整单明细确认、项目归属、对账）用吸底操作栏（`{components.action-bar}`）：横跨整个工作面宽度，贴在工作面底边，1px 上边线，
高 `{layout.action-bar-height}`。左侧一句后果说明，右侧按钮，主按钮在最右。它不是内容里的一张卡片。

### 概览条

任务列表的页头下是一条概览：进行中、对账中、已交接、待你处理的数量，**全部由服务端给出**（页面不数行）。
四格等宽，格间 1px 竖线，数字 `{typography.metric}`，下方一行 `{typography.label}` 说明。它是一条细带，不是四张卡片。

**暂缓**：任务列表契约里还没有这四个计数字段，改版先不做概览条，等服务端给出字段再加。
工具栏里的状态筛选可以在每个选项后显示条数：那是页面已拿到的这张列表按状态标签分的行数（与「N 份材料」取文件清单长度同理），
不是业务统计；「待你处理」不做筛选项，它需要服务端判断。

## 布局尺寸

`layout` 组收纳页面 CSS 需要、又不属于颜色/字号/圆角/间距的固定尺寸：表单最大宽、页面内边距、框架缝宽、三档行高、工具栏与操作栏高度、图标尺寸、进度条粗细与宽度、搜索框与提示宽度；
以及 hairline 与焦点环粗细、小号与大号控件高度、头像圆点尺寸、左侧状态细条宽度、页面最小宽度、上传拖放区最小高度、文件列表大小列宽、
项目归属右侧工作台宽度与明细表最小宽度、待确认项右侧表单栏宽度、弹层宽度、复选框尺寸、打印稿预览的页卡最小宽度、四角裁剪编辑器宽度与角点尺寸。新的尺寸先加到这里，再在 CSS 里引用。

## 各页版式

所有页面都在同一张白色工作面里，节与节之间用细分隔线或 layer-2 细带，不再是灰底上的一排白卡片。

- **上传材料**：拖放区在最上面；每个上传批次是一节（标题一行加状态标签），文件是通栏的紧凑行（序号、文件名、状态标签、内容哈希、大小）。
- **材料盘点**：一句结论打头，计数说明在其下一行；表格通栏。全部通过的费用事件收成一行，这一行按表头的四列排开
  （序号与类别在「文件」下、日期在「识别为」下、金额在「校验」下、材料数在「状态」下），展开后的材料行与表头同列对齐；
  含待确认材料的事件默认展开，左侧一条 warning 细条。
- **待确认项**（核对页）：上面是紧凑的队列（每项一行：状态图标、标题、文件与处理人），下面左边是大尺寸原件（layer-2 底上的一页，
  随页面滚动时贴在顶栏下），右边 `{layout.pending-side-width}` 宽的一栏放读出的字段与补填表单。
- **项目归属**：左边明细按类别分组，每条明细一行（No.、日期、城市、路线与脱敏票号、项目、价税合计），各组共用一套列宽、表头只画一次；
  右边工作台功能不变（本次已归入、可选项目、就地新增）；提交在吸底操作栏里。
- **保存报销草稿、对账、完成**：步骤用 Carbon 竖排进度指示（状态图标加状态文字）；回读表通栏、窄窗口横向滚动，No. 固定在左、比对列固定在右；
  草稿号与严格回读结论放在摘要条里。对账页的两个处置各带说明，是工作面里的两栏（与确认后的「去打印 / 去报销」同样），不放进吸底操作栏。
- **打印稿预览**：页卡是 layer-2 底上的一页纸，页眉用标签字号，不用等宽。
- **个人项目簿**（全局页、维护门与就地新增弹层共用）：录入是表格上方的一行；复检与清理是表级动作，放在工具栏右侧；表格通栏，项目号固定在左、操作列固定在右。
- **设置、启动页**：表单页，内容限宽 `{layout.form-max-width}`，不画卡片边框。

## 版式规则

每个页面都守这几条：

- **不留无用的空**：表格页铺满主区；节与节之间用 1px 分隔线或 layer-2 的细带分开，不用大块垂直留白（IBM："sections separate via thin gray rows"）。
- **标题下最多一句话**：页面标题下的说明不超过一句、30 个字以内；其余解释放进可展开的说明或提示里。
- **一屏一个主按钮**：其余动作用次级或三级按钮（"去打印""去报销"并列是唯一例外）。
- **只标记例外，但状态要看得出**：需要处理的状态用语义色标签；正常的推进状态用"进行中"蓝标签加进度，不再一律灰色。
- **数字对齐**：金额、日期、计数用 `tabular-nums`，金额右对齐；等宽字体只给标识符。
- **不用中点拼元信息**：不写"A · B · C"这种串，用带标签的字段或表格列。不用全大写标签。

## 步骤条

任务页不再有侧栏。原因：PR #120 用户 QA 指出纯文字的侧栏"看不出是按步骤推进"（"侧边栏需要改成之前那种按照步骤推进的效果，或者不要侧边栏了，全铺开是否更加大气一点"），
两条一起做：去掉侧栏，把横排的步骤条（Carbon progress indicator 的样式）放在白色工作面最上面；工作面在所有页面都铺满宽度，宽表格有更多地方。
个人项目簿、设置、任务列表本来就没有侧栏，版式不变。

步骤条是工作面顶部通栏的一行，下边一根 1px 分隔线，在页面标题之上，随页面滚动（不吸顶）：

- 左边：任务名（`{typography.heading-sm}`，一行，超长省略，完整名称放在 `title` 里），下面一行 `{typography.label}` 灰字的费用期间（服务端给出时才有）；
  宽 `{components.step-bar.taskWidth}`，最窄可缩到 `{components.step-bar.taskMinWidth}`。
- 右边：7 步横排（上传材料、材料盘点、待确认项、项目归属、整单明细确认、去打印 / 去报销、完成），每步是 `{components.step-bar.markerSize}` 的圆形标记加标签，
  步与步之间一根 `{components.step-bar.connectorWidth}` 连线吸收剩余宽度（不短于 `{components.step-bar.connectorMinWidth}`）。
  - 已完成：强调色细圈里一个强调色的 Carbon `checkmark`，标签 `{colors.ink-muted}`；它后面的连线是强调色。
  - 当前：强调色实心圆里白色序号，标签 `{colors.ink}` 600 字重；`aria-current="step"`。
  - 能进但不是当前也没完成（比如在上传页回看时后面已到的步骤）：细灰圈里灰色序号，标签 `{colors.ink-muted}`，是链接。
  - 未到：`{colors.hairline}` 细圈里三级灰序号，标签 `{colors.ink-tertiary}`，是带 `aria-disabled` 的按钮；连线细灰。
  - 待确认项的数量是标签后的中性灰小胶囊（`{colors.surface-3}` 底），不做彩色徽标。
  - 序号由 CSS 从 `data-n` 画出，不进可访问名称；步骤的可访问名称就是步骤名，列表名是「流程阶段」。
- 被守卫拦下的页面不把对应步骤显示成当前；点未到的步骤时，步骤条下方出现一句「阶段不可跳过，请按顺序完成。」（`role=status`）。
- 对账中的任务：右边不是步骤，而是一个 warning 标签（等待对账 / 已转人工）加一句短说明。
- 当前阶段的 10 阶段名只出现在任务列表的进度列上，个人项目簿走顶栏导航，都不在步骤条里重复。

宽度：1280px 以上任务名与 7 步在同一行；1280px 以下任务名与费用期间排成上面一行，7 步占满下面一行，标签降到 13px（`{typography.body-compact}`）；
1100px 仍然一行放下 7 步，标签不折行、步骤条不横向滚动。900px 以下只保留当前步的标签，其余步只剩圆形标记（标签对读屏仍在）。

上一版的侧栏收起按钮、窄栏和 localStorage 偏好 `baox.sidebar.collapsed` 随侧栏一起删除；`components.sidebar` 的宽度 token 已删。

## 语义色

见上文「状态色」表。徽标与标签里的颜色必须对应表里的一种状态；不用彩色圆点做装饰。

## 不做的事

- 不用渐变、光晕、投影。
- 不用第二种强调色（`{colors.info}` 只做状态，不做交互色）。
- 不用 Carbon 的 0px 直角与 IBM 的 300 细体大字。
- 不在标题前加小字眉题；不用全大写标签；不用中点拼元信息。
- 不用 em-dash 和 en-dash，范围写作 `No.2-4`。
- 不手绘 SVG 图标，不混用第二个图标库；按钮上不加"→"。
- 不在表格页设最大宽度，不让 13 列的确认表在 1440px 以上横向滚动。
- 不引入 Carbon 的 npm 包：样式仍由本文件生成 `tokens.css`，页面写纯 CSS。
