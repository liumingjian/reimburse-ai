# @baox/app-ui 设计规则：Carbon Gray 10 原样，加本应用的规则

## 用途与来源

这份文件是 `@baox/app-ui` 所有页面的视觉依据。决定见 `docs/adr/0008-adopt-carbon-react.md`：界面改用 IBM Carbon 的
`@carbon/react` 组件与 `@carbon/styles`，主题 **Gray 10（g10）**，颜色、直角、间距、行高、字阶都照 Carbon 原样；
上一版的 Linear 品牌层（强调色 #5e6ad2、8/12px 圆角、pill 标签）已删除。

本文件不再有 front matter，也不再生成任何文件：原先把 front matter 生成为 `tokens.css` 的 `scripts/build-tokens.mjs`、
`tokens.css` 与它的测试随迁移删除。颜色与尺寸一律取 Carbon 的 token（Sass 变量，输出为 `var(--cds-…)`），不写字面颜色。

- 样式入口 `src/styles/carbon.scss`：Carbon 配置（不输出 IBM Plex 字体）、系统字体、Gray 10 主题、reset、布局 token，
  然后按组件引入用到的 Carbon 组件样式（按钮、UI Shell、进度指示、弹层、数据表格、搜索、标签、提示、内容切换、通知、进度条、表单、输入框、复选框、链接、溢出菜单），
  以控制单文件体积。要用新的 Carbon 组件时在这里加一行 `@use '@carbon/styles/scss/components/<名字>'`。
- 本应用的版式规则 `src/styles/_app-rules.scss`：只写 Carbon 不管的部分（下文「本应用的规则」），类名一律以 `app-` 开头，
  只引用 Carbon 的 spacing、theme、type token。尽量不改 `.cds--*` 的内部样式；确实要改时（如表格固定列、单元格里的按钮内边距）在规则旁写明原因。
- 图标只用 `@carbon/icons-react`，不手绘，不混用第二个图标库。

getdesign 原件（linear.app、ibm、airtable）仍在 `prototypes/design-md/`，只作溯源；Carbon 原样与套品牌的对照原型在分支 `proto-carbon-react`。

## Carbon 原样的部分

- **主题**：Gray 10。页面底色 `$background`（#f4f4f4），表格、摘要条、步骤条、操作栏等内容层 `$layer-01`（白），表头 `$layer-accent-01`。
  主按钮是 Carbon 的 `$button-primary`（#0f62fe），直角。一屏一个主按钮（「去打印」「去报销」并列是唯一例外）。
- **字体**：系统字体（苹方），在 `carbon.scss` 里把 Carbon 的 `font-family` 映射整体换掉一次；**不打包 IBM Plex**。
  字号、字重、行高照 Carbon 的字阶（heading-04 页面标题、heading-03 节标题、body-01 正文、body-compact-01 宽表单元格、label-01 / helper-text-01 说明）。
  等宽只给标识符（草稿号、项目号、费用项目编码、内容哈希），用系统等宽字体；日期、金额、No. 用正文字体加 `tabular-nums`。
- **组件**：顶栏 UI Shell Header（HeaderNavigation：报销任务 / 个人项目簿 / 设置；右侧模拟数据标签与报销人）；
  步骤条 ProgressIndicator；弹层 ComposedModal；表格 Table 系列（TableContainer、TableToolbar、TableToolbarSearch）；
  状态 Tag；提示 InlineNotification；限制说明 Tooltip / Toggletip；表单 TextInput、Checkbox、Search；进度 ProgressBar；筛选 ContentSwitcher。
- **状态标签**：用 Carbon 的 Tag 类型，永远带文字，颜色只是第二通道：进行中 `blue`，完成 `green`，出错 `red`，中性 `gray`。
  Carbon 没有黄色标签：**需要注意**（对账中、待确认、已转人工、已锁定）用最接近的 `warm-gray` 加警告图标。
- **不随迁移加入**：DataTable 的排序、行选择与批量操作栏、行展开。整单明细的顺序由服务端决定（打印稿序号与报销系统明细行共用），
  能不能让用户重排是业务问题，以后逐项评审。表格一律照服务端给的顺序，不放排序按钮。

## 本应用的规则（Carbon 不管）

### 界面文字只有中文

Carbon 组件自带的英文文案全部经组件参数换成中文，不留一个英文词：

| 组件 | 做法 |
| --- | --- |
| ProgressStep 读屏状态（Complete / Current / Incomplete / Invalid） | `translateWithId`：已完成 / 当前 / 未完成（未到的步骤是「未开放」）/ 无效 |
| ComposedModal 关闭按钮（Close） | `ModalHeader iconDescription="关闭"` |
| Modal 焦点哨兵（隐藏的「Focus sentinel」） | `FeatureFlags enableFocusWrapWithoutSentinels`（`App.tsx`） |
| OverflowMenu 浮层的焦点哨兵（同上） | 浮层读 `@carbon/feature-flags` 的全局开关而不是上面的上下文：`App.tsx` 顶部 `merge` 同一个开关 |
| TableToolbar（data table toolbar）、TableToolbarSearch（Filter table、Clear search input） | `aria-label`、`labelText`、`placeholder`、`closeButtonLabelText` 都传中文 |
| Search（Search、Clear search input） | `labelText`、`placeholder`、`closeButtonLabelText` |
| InlineNotification 图标标题（error icon 等） | `statusIconDescription`：错误 / 注意 / 提示 / 成功 |
| OverflowMenu 菜单按钮（Options）、菜单 | `iconDescription="更多"`，`aria-label` 写「<任务名>的更多操作」 |

e2e `e2e/carbon-zh.spec.ts` 在主要页面与打开的弹层里查整页文字（含读屏文字、SVG 标题）和 `aria-label`、`title`、`placeholder`，
出现 Carbon 常见英文文案即失败。新用一个 Carbon 组件时先查它的默认英文参数。

另外照旧：不用 em-dash 与 en-dash（范围写作 `No.2-4`）；按钮文字后不加箭头「→」；遵守内核禁用词（报销系统不写作 ERP，不说「候选」）。

### 页面不计算、不判定

页面只显示服务端给出的值（条数、合计、状态、能否操作），不求和、不推断；工具栏的搜索与状态筛选只是在已拿到的列表里挑行显示。

### 宽度按页面类型定

| 页面类型 | 宽度 | 例子 |
| --- | --- | --- |
| 表格页、核对页、左右分栏页 | 铺满工作区，不设最大宽 | 任务列表、整单明细确认、盘点、待确认项、项目归属、对账、打印稿预览 |
| 表单页、说明文字 | 最大 45rem（720px） | 设置、启动页、个人项目簿的录入行 |

工作区左右页边 24px（`$spacing-06`）。表格、摘要条、步骤条、操作栏在工作区里通栏（`.bleed`，贴到左右边），首列与末列再用同样的页边留白，
所以首列文字仍与页面标题对齐。

### 宽表格：有空间就铺满，没空间就横向滚动

每张宽表（整单明细确认、任务列表、回读与对账、个人项目簿）放在 Carbon 表格自带的 `overflow-x: auto` 容器里，表格铺满。
窗口比各列按内容收紧后的宽度之和还窄时，整张表横向滚动，不再挤压列宽。滚动时标识列固定在左（No.；没有 No. 的表是任务名 / 项目号），
收尾列固定在右（总额；任务列表与项目簿是操作列；回读表是比对列），固定列带所在行的底色，只有那一侧真有内容被盖住时才出现一条分隔线。
操作列每行只放一个主操作按钮，其余操作收进 Carbon OverflowMenu「更多」；破坏性操作是其中的 delete 项，
不能做时菜单项置灰，下面照抄服务端给出的原因。不再每行摆带锁的不可用按钮。
整单明细表（No. 加 13 列）单元格用 body-compact、列间距用 Carbon 最小的单元格内边距，在 1440px 窗口上不横向滚动；1100px 窗口会滚动，这是预期的退路。
项目号与费用项目是「编码 / 名称」一对，不折行；出发点、目的地、费用分类可以折行（中文 `word-break: keep-all`）。
同一分类里与上一行相同的文字单元格变淡（值照常在），金额列不变淡。

### 步骤条

任务页工作区顶部一条（`$layer-01`，下边一根细线），在页面标题之上，随页面滚动：左边任务名与费用期间，右边 Carbon ProgressIndicator 横排 7 步
（上传材料、材料盘点、待确认项、项目归属、整单明细确认、去打印 / 去报销、完成），列表的可访问名称是「流程阶段」，整条是「任务进度」区域。

- 已完成与已到的步骤可点，点了进入对应页面；当前步骤 `aria-current="step"`。
- 未到的步骤带 `aria-disabled`、用 Carbon 的不可用颜色，但仍可点：点了在步骤条下出现「阶段不可跳过，请按顺序完成。」（`role=status`）。
  不用 Carbon 的 `disabled`，因为它的样式带 `pointer-events: none`，点了没有说明。
- 被页面守卫拦下时不标当前步骤。盘点之后，待确认项下面一行显示「N 项待处理」。
- 对账中的任务不列步骤，而是一个 warm-gray 标签（对账中 / 已转人工）加一句说明。
- 1280px 以下任务名排在上面一行，7 步占满下面一行；1100px 仍然一行放下 7 步、标签不折行、步骤条不横向滚动。

### 页面操作栏与并列入口

需要整页确认的页面（整单明细确认、项目归属）用吸底操作栏：通栏、贴视口底边、1px 上边线，左边一句后果说明，右边按钮，主按钮在最右。
确认后的「去打印 / 去报销」与对账的两种处置是工作区里的两栏（中间一条竖线），不放进吸底操作栏。

### 危险确认

破坏性、不可撤销的确认（作废任务、完全重置）一律用确认弹层的危险变体（`ConfirmDialog danger`）：Carbon danger modal，
确认按钮是红色 `danger` 按钮，文案仍是具体动作（「作废」「清空并重置」）。普通确认（如新建报销任务）仍用蓝色主按钮。

### 摘要条

整单明细确认、完成、对账页在标题下有一条通栏的摘要（`$layer-01`，上下细线）：带标签的字段（label-01 灰字 + 值），
价税合计用 heading-03 大一号。材料包清单是摘要条里的一个展开按钮，展开后铺在摘要条下方。所有数字来自服务端。

### 没有 Carbon 对应物、保持手写的部分

四角裁剪编辑器、打印稿页卡与页图、待确认项的原件预览、盘点页按费用事件归组的清单、竖排的填报 / 盘点步骤清单（每步里要嵌登录说明与按钮）、
上传拖放区。它们的颜色与间距同样只取 Carbon token，控件（按钮、输入框、标签、提示）用 Carbon 组件。

### 标题与版式

- 标题下最多一句话，其余解释放进 Toggletip 或说明里。
- 不在标题前加小字眉题；不用全大写；不用中点拼元信息串（表格与带标签的字段代替）。
- 概览条（进行中 / 对账中 / 已交接 / 待你处理的计数）暂缓：任务列表契约里还没有这些字段。

## 不做的事

- 不用 Linear 品牌层（#5e6ad2、圆角、pill 标签），不打包 IBM Plex。
- 不加表格排序、行选择与批量操作栏、行展开（以后逐项评审）。
- 不写字面颜色；不引入第二个组件库或图标库。
- 不用 em-dash 和 en-dash；按钮上不加「→」。
