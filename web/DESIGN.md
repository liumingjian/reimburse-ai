# @baox/web 设计规则：Carbon Gray 10 原样，加本应用的规则

## 用途与来源

这份文件是 `@baox/web` 所有页面的视觉依据。决定见 `docs/adr/0012-adopt-carbon-react.md`：界面改用 IBM Carbon 的
`@carbon/react` 组件与 `@carbon/styles`，主题 **Gray 10（g10）**，颜色、直角、间距、行高、字阶都照 Carbon 原样；
上一版的 Linear 品牌层（强调色 #5e6ad2、8/12px 圆角、pill 标签）已删除。

本文件不再有 front matter，也不再生成任何文件：原先把 front matter 生成为 `tokens.css` 的 `scripts/build-tokens.mjs`、
`tokens.css` 与它的测试随迁移删除。颜色与尺寸一律取 Carbon 的 token（Sass 变量，输出为 `var(--cds-…)`），不写字面颜色。

- 样式入口 `src/styles/carbon.scss`：Carbon 配置（不输出 IBM Plex 字体）、系统字体、Gray 10 主题、reset、布局 token，
  然后按组件引入用到的 Carbon 组件样式（按钮、UI Shell、进度指示、弹层、数据表格（含工具栏批量操作与可展开行两个单独的分文件，漏引则展开箭头不转）、搜索、标签、提示、内容切换、通知、进度条、表单、输入框、复选框、链接、溢出菜单），
  以控制单文件体积。要用新的 Carbon 组件时在这里加一行 `@use '@carbon/styles/scss/components/<名字>'`。
- 本应用的版式规则 `src/styles/_app-rules.scss`：只写 Carbon 不管的部分（下文「本应用的规则」），类名一律以 `app-` 开头，
  只引用 Carbon 的 spacing、theme、type token。尽量不改 `.cds--*` 的内部样式；确实要改时（如表格固定列、单元格里的按钮内边距）在规则旁写明原因。
- 图标只用 `@carbon/icons-react`，不手绘，不混用第二个图标库。

getdesign 原件（linear.app、ibm、airtable）仍在 `docs/design/prototypes/design-md/`，只作溯源；Carbon 原样与套品牌的对照原型在分支 `proto-carbon-react`。

## Carbon 原样的部分

- **主题**：Gray 10。页面底色 `$background`（#f4f4f4），表格、摘要条、步骤条、操作栏等内容层 `$layer-01`（白），表头 `$layer-accent-01`。
  主按钮是 Carbon 的 `$button-primary`（#0f62fe），直角。一屏一个主按钮（「去打印」「去报销」并列是唯一例外）。
- **字体**：系统字体（苹方），在 `carbon.scss` 里把 Carbon 的 `font-family` 映射整体换掉一次；**不打包 IBM Plex**。
  字号、字重、行高照 Carbon 的字阶（heading-04 页面标题、heading-03 节标题、body-01 正文、body-compact-01 宽表单元格、label-01 / helper-text-01 说明）。
  等宽只给标识符（单据编号、项目号、费用项目编码、内容哈希），用系统等宽字体；日期、金额、No. 用正文字体加 `tabular-nums`。
- **组件**：顶栏 UI Shell Header（HeaderNavigation：报销任务 / 个人项目簿 / 设置；右侧模拟数据标签与报销人）；
  步骤条 ProgressIndicator；弹层 ComposedModal；表格 Table 系列（TableContainer、TableToolbar、TableToolbarSearch）；
  状态 Tag；提示 InlineNotification；限制说明 Tooltip / Toggletip；表单 TextInput、Checkbox、Search；进度 ProgressBar；筛选 ContentSwitcher。
- **状态标签**：用 Carbon 的 Tag 类型，永远带文字，颜色只是第二通道：进行中 `blue`，完成 `green`，出错 `red`，中性 `gray`。
  Carbon 没有黄色标签：**需要注意**（对账中、待确认、已转人工）用最接近的 `warm-gray` 加警告图标，
  图标照 Carbon 警告通知的画法（`$support-warning` 填充，里面的「!」深色），各页的警告标签一律经 `StatusTag` 的 `warning` 语气，看起来一样；
  已锁定用 `warm-gray` 加锁，锁不上黄色。
- **不随迁移加入**：DataTable 的排序、行选择与批量操作栏。#135 起行选择只用在项目归属页（#138，见下文「项目归属：勾选明细，点右侧项目归入」；那里也不用批量操作栏），行展开只用在材料盘点的费用事件表（#137，见下文「盘点清单」）。整单明细的顺序由服务端决定（打印稿序号与报销系统明细行共用），
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
Task rows show the row's main action and Abandon (作废) as adjacent small ghost buttons on every row, whatever the task's status. A blocked abandonment stays disabled and exposes the server-provided reason on hover or keyboard focus. Project maintenance rows show three adjacent text buttons: Edit (编辑), Deactivate/Restore (停用/恢复), and Delete (删除). Deletion uses a danger ghost button and requires confirmation; public maintenance actions are administrator-only.
整单明细表（No. 加 13 列）单元格用 body-compact、列间距用 Carbon 最小的单元格内边距，在 1440px 窗口上不横向滚动；1100px 窗口会滚动，这是预期的退路。
项目号与费用项目是「编码 / 名称」一对，不折行；出发点、目的地、费用分类可以折行（中文 `word-break: keep-all`）。
同一分类里与上一行相同的文字单元格变淡（值照常在），金额列不变淡。

### 步骤条

任务页工作区顶部一条（`$layer-01`，下边一根细线），在页面标题之上，吸顶（sticks under the global header on every task page and publishes its height as `--app-stepbar-h`, so other sticky parts pin below it）：左边任务名与费用期间，右边 Carbon ProgressIndicator 横排 7 步
（上传材料、材料盘点、待确认项、项目归属、整单明细确认、去打印 / 去报销、完成），列表的可访问名称是「流程阶段」，整条是「任务进度」区域。

- 已完成与已到的步骤可点，点了进入对应页面；当前步骤 `aria-current="step"`。
- 未到的步骤带 `aria-disabled`，文字用 `$text-secondary`（不用 Carbon 的不可用色，全流程读得清），与已到的步骤靠图标区分；仍可点：
  点了在被点步骤的正下方出现「阶段不可跳过，请按顺序完成。」（`role=status`）。守卫页正文已说明同一件事，守卫页上不出这条提示。
  不用 Carbon 的 `disabled`，因为它的样式带 `pointer-events: none`，点了没有说明。
- 被页面守卫拦下时不标当前步骤。盘点之后，待确认项下面一行显示「N 项待处理」。
- 对账中的任务不列步骤，而是一个 warm-gray 标签（对账中 / 已转人工）加一句说明。
- 1280px 以下任务名排在上面一行，7 步占满下面一行；1100px 仍然一行放下 7 步、标签不折行、步骤条不横向滚动。

### 页面操作栏与并列入口

每个任务步骤页的下一步主按钮都在吸底操作栏里（材料盘点的「处理 N 个待确认项 / 进入项目归属」、上传材料的「开始材料盘点」加 ghost 的「追加下一批」、项目归属、整单明细确认），步骤页的页头只有标题与导语；
页头右侧只留给页面级的新建操作（任务列表的「新建报销任务」）。待确认项页不算：「保存并标记已处理」是逐项表单的提交，不是这一步的下一步。
需要整页确认的页面和对账页的处置同样用吸底操作栏：通栏、贴视口底边、1px 上边线，左边一句后果说明，右边按钮，主按钮在最右。
左边的后果说明不重复页头导语，写导语里没有的信息；没有新信息就不写。
对账页顶部只有一条错误通知（标题「写入结果不确定」，副标题是中止原因）；单据编号、对账结果句等事实进摘要条；人工核对固定句写在吸底栏的后果说明里。

- 吸底栏按钮分量：只有一个主按钮，文案说清确认的是什么（如「确认整单明细」「确认项目归属」），不单写「确认」。
  往回走的操作（回到上一步修改、回到待确认项）一律用 ghost，不用 secondary，不与主按钮争分量。

确认后的「去打印 / 去报销」是工作区里的两栏（中间一条竖线），不放进吸底操作栏。
整单明细确认后，两栏紧跟在摘要条下方、明细表之前，1440px 窗口下在首屏内。

### 上传材料

拖放区是手写的（Carbon 的 `FileUploaderDropContainer` 只接受一行文字标签），QA 时从原型的三个方案里选定了居中插画版：
虚线框铺满页面宽度，居中放「文档 + 蓝色上传角标」插画、主文案「把材料拖到这里」、链接样式的「或 点击选择文件，可一次选多份」和格式标签（PDF / JPG / PNG / 单个 ≤ 20MB）；
拖入时变蓝底实线、文案换成「松开即可上传」，上传中换成进度条。追加下一批用同一样式的单行紧凑版。拖放区的可访问名称仍是「拖入文件，或点击选择」。
框下两行说明：上传后要点「开始材料盘点」；原件会被复制进任务目录，不会被修改。文件行只给拒绝的文件打红色「拒绝」标签加原因，已接收的不打标签；内容哈希放在文件名的悬停提示里；
图标按扩展名区分 PDF 与图片。

### 项目归属：勾选明细，点右侧项目归入

The project assignment page is the one exception to "no row selection" above (#135), and it has no batch action bar and no modal:
tick lines on the left, then click a project on the right.

- Selection bar (`role="group"` 明细选择与筛选): sticks under the step bar while the lines scroll. One row holds 全选当前明细 (select all
  visible lines), the filter (ContentSwitcher 全部 / 未归属, all / unassigned, sized to its content) and a status line
  (`assign-selection`) saying what to do next: 勾选明细后，点右侧项目归入 → 已选 N 条，点右侧项目归入 → 已归入 <number> <name>
  after a successful assignment. While lines are ticked the bar turns `$background-brand` and a ghost 取消选择 (clear selection) button appears.
- 归入项目 (assign to project) panel: a `complementary` region beside the table, sticky between the step bar and the action bar.
  The head (title, a status caption 先勾选左侧明细 / 已选 N 条 / 不能再修改, and a Search 查找项目) stays put; only the project list scrolls.
  Every project is a full-width button (name, then number, 个人 / 公共 source Tag); clicking it assigns the ticked lines at once, with no
  apply button. Projects already used here come first under 本次已归入 (used this time) with line count and amount (`2 条 / 47.54 元`,
  from the server); the rest follow under 可选项目 (selectable projects) in project-book order. A used project that left the allowed list
  shows 已锁定 (locked) and stays disabled. All projects are disabled until a line is ticked, while ERP writing has started, and while
  the conflict dialog is open.
- Search matches the project number or name as a substring or with its characters in order (an abbreviation finds the full name) and marks
  the hit characters; no hit shows 没有匹配的项目. Enter assigns the ticked lines when exactly one selectable project matches.
- If a ticked line already has another project, a ConfirmDialog asks 只处理未归属 (only unassigned) / 确认覆盖 (overwrite) / 取消; cancel keeps the ticks.
- The panel foot has 新增项目 (add project), which opens the project-book panel in a dialog; after 完成 the ticks are kept and the new
  project appears in the list.
- Below 1280px the panel narrows (18rem) but stays beside the table; only below 56rem does it stack under the table and stop sticking.

### 版式统一 (layout consistency, #319)

Every card, button group, key/value block and file name is built from one shared component in `src/shell`, and each of
those sits on a Carbon component. A page does not hand-build a card, a button row or a key/value block; when it needs
one the shared components cannot express, extend the shared component. Evidence of what went wrong before:
`docs/review/ui-consistency/`.

| Need | Component | On Carbon |
| --- | --- | --- |
| Up to about six overview fields | `FieldGroup` (字段网格, field grid): label above, 2 or 4 equal columns | `Grid` / `Column` |
| Many fields read row by row (a material's recognised fields) | `DetailList` (详情列表, detail list): label left | `StructuredList`, condensed, flush |
| The numbers under a page header | `SummaryBar` + `SummaryField` | hand-built, Carbon tokens |
| Buttons in content | `ActionGroup` | `ButtonSet` |
| Buttons of a whole step | `ActionBar` | `ButtonSet` |
| A block with a title, text and its own actions | `Card` in a `CardRow` | `Tile` |
| Switching between views of one thing | `ContentSwitcher` | `ContentSwitcher` |
| A file name | `FileName` | hand-built |

- **Key/value**: one form per panel, `FieldGroup` or `DetailList`, never both. No colon strings (`来源：…`), no `·` strings,
  no bare `<dl>`.
- **Button sizes**: `ActionBar` and page-header actions use the default `lg`; in-content groups `md`; table-row actions
  `sm` ghost. Buttons of one group share one width (the widest label, at least Carbon's 196px) and one height.
- **Page header actions** share one width too (the header's action area is laid out like a ButtonSet).
- **Switchers vs answers**: `ContentSwitcher` only switches what is shown (结账单 / 发票, 个人 / 公共项目簿, task filters).
  A pending item's choices submit an answer, so they stay buttons in an `ActionGroup`, the chosen one marked with
  `aria-pressed`.
- **Button kinds**: at most one primary per region, placed last. A reversible side action (排除这份材料, exclude this
  material) is ghost, not danger; danger is only for the irreversible confirmations under「危险确认」.
- **Captions and errors** go under the whole button group, never between buttons.
- **Summary bar**: fields of equal width filling the row; a sentence-long value (对账结果) spans two. Display only: an edit
  control goes to the page's actions, so the bar keeps one height.
- **Cards**: one padding; cards in a row share its height; actions pinned to the bottom so neighbouring buttons line up.
- **File names**: one line with a middle ellipsis keeping the last 12 characters (the date stamp and extension that tell
  one supplier's files apart), full name on hover. A `DetailList` row may show the full name.
- **Wrapping**: body text uses `text-wrap: pretty`, so no line holds one orphaned glyph; table headers do not wrap,
  except the whole-claim table's `.app-wrap-head`.
- **Guard**: `src/layout-rules.test.ts` fails when a page hand-builds a button row, summary bar, card or label-left list,
  or gives an action bar's buttons a size.
- **Screen widths**: layouts hold from 1280 to 1920px. `node web/scripts/ui-shots.mjs` screenshots every mock state
  for before/after comparison of a layout change.

### 危险确认

破坏性、不可撤销的确认（作废任务、完全重置）一律用确认弹层的危险变体（`ConfirmDialog danger`）：Carbon danger modal，
确认按钮是红色 `danger` 按钮，文案仍是具体动作（「作废」「清空并重置」）。普通确认（如新建报销任务）仍用蓝色主按钮。

### 摘要条

整单明细确认、完成、对账、材料盘点页在标题下有一条通栏的摘要（`SummaryBar`，`$layer-01`，上下细线）：等宽的带标签字段（label-01 灰字 + 值），
价税合计用 heading-03 大一号。材料包清单是摘要条里的一个展开按钮，展开后铺在摘要条下方。所有数字来自服务端。
盘点页的摘要条放材料、通过、需处理、主要报销凭证、参考材料的份数与盘点版本、盘点时间，取 `inventory.summary`；标题下不再另起一行大号计数。

### 待确认项：原件与表单

- 上面是待确认项清单：每行只放警示或完成图标、标题、文件名。已处理的行降低对比，并带绿色「已处理」标签。契约里的处理人这一页不显示。
- 下面两栏贴顶：左边原件栏固定占 2/5，缩放后的原件在其中居中（切换待确认项时表单栏左边不跳）；右边占其余 3/5（下限 400px），依次是标题与原因、补填表单、读出的字段（文件名、材料类别与识别字段同在一个详情列表 `DetailList` 里）。
- 原件在「一屏高度减去顶栏、步骤条和页头」的框内等比缩放，页面滚动时原件栏贴在步骤条下。PDF 与「没有可用的预览」用同样高度的框，占位不改变版面位置。
- 1056px 以下原件在上、表单在下。
- 住宿发票的支付截图项（ADR-0032）：文件框可多选，选好就一次传上去；服务端把它们归到这张发票并重新盘点，页面随之转到材料盘点。按钮组里「上传支付截图」是次要按钮，不设张数上限。截图合计少于发票价税合计时，这一项给「已传齐」选项确认就这些。#331 存在旧表里的截图组仍按上传顺序排成一行缩略图，每张下面一个移除图标按钮，上方写「已传 N 张」，「已传齐」是主按钮、放最后；「确认没有支付截图」只在没有任何截图时出现。
- 已处理的支付截图项（#332，排除的除外）仍可增删：在队列里选中它，或在「没有待确认项了」的表格里点这一行的幽灵按钮「修改支付截图」展开详情。展开后照样有缩略图、移除和「上传支付截图」，但没有「已传齐」。上传取代「确认没有支付截图」、删空一组，都会让这一项回到待处理，页面回到队列并停在这一项。整单明细确认后或已开始写入报销系统后，不再提供增删：没有「修改支付截图」，详情里只列缩略图并写明不能再增减。

### 原件查看器：仅供查看，不存

- 原件框里不放工具栏，只把原件整页显示出来；框下一个「全屏查看」（Carbon ghost 小号按钮），点原件本身也打开全屏。不提供放大、缩小：框太小时框内放大也看不清，看不清就点开全屏，一步就够（QA 2026-09-30）。
- 全屏查看（DocFullscreen）铺满整个浏览器窗口，只放原件：尽量放大，宽度到窗口宽为止、最多 1024px（再宽只是字变大、要滚得更多），比窗口高就往下滚动。只有两个操作：右上角关闭（点空白处、按 Esc 也关），和「旋转 90°」图标按钮。住宿有多份材料时，顶部同样放切换条，不用退出全屏就能切换。
- 旋转只取 0、90、180、270，转到 90° 或 270° 时按交换后的宽高重新适应；全屏里转过的角度，原件框里也跟着转。
- 查看状态只在页面里：切换待确认项时回到默认，不写入服务端，不影响打印稿的旋转、裁剪，也不影响整单明细确认。
- PDF 原件先在页面里用 pdf.js 渲染成一张图（逐页竖排，最多 6 页，多出的页提示打开原件），框里和全屏共用这张图；在框里铺满框宽、竖向滚动，而不是整页塞进框高（竖版 A4 那样太小，看不清）。渲染失败（如 mock 的 file://）才退回浏览器自带的 PDF 预览，这时不提供全屏查看。
- 全屏查看从弹窗里打开（项目归属页的「住宿材料」）时挂到页面最外层，铺满窗口而不是困在弹窗里；Esc 只关全屏，弹窗还在。
- 住宿的原件栏只看结账单或其他证明材料，不给发票：结账单上列着具体事项和金额，能提醒员工要填什么；发票本身没有这个作用。

### 打印稿预览：平铺，只看、只调版面

- 页图平铺成网格，一屏看多页；每行 3、4、5 页由员工用切换器选，默认 4 页，记在本机浏览器。点页图用同一个全屏查看看这一页（只看，不在全屏里调版面）。
- 页上不写「上半页 / 下半页」「放置」「裁剪」这类说明。每一半页图的右上角是图标按钮：旋转 90° / 改为竖放，照片还有调整四角；名称和提示里带文件名。
- 预览页不补充支付截图：住宿发票缺支付截图在待确认项里上传。
- 住宿发票有两张及以上支付截图时，发票页之后紧跟一张支付截图续页（#333），页眉「No.N 支付截图（续）」带酒店名与金额。续页和其他页一样平铺、计入页数、点开全屏查看、在下载的 PDF 里；它没有放置，所以页图上没有旋转、裁剪按钮。
- 页图按需加载（`loading="lazy"`），不在视口里的页先不下载。

### 没有 Carbon 对应物、保持手写的部分

四角裁剪编辑器、打印稿页卡与页图、待确认项的原件预览、竖排的填报 / 盘点步骤清单（每步里要嵌登录说明与按钮）。
它们的颜色与间距同样只取 Carbon token，控件（按钮、输入框、标签、提示）用 Carbon 组件。

### 盘点清单

费用事件表是 Carbon 可展开表格（TableExpandHeader / TableExpandRow / TableExpandedRow），每行一个费用事件组。

- 收起的组行五列：费用事件（No. 区间与类别）、日期、金额（服务端给的各事件价税合计，不求和）、份数、状态。
  状态列显示组内最严重的材料状态：待确认 > 待盘点 > 已排除 > 无。
- 含待确认材料的组默认展开，其余默认收起；用户点过的记在界面状态里。表头的展开按钮是「全部展开 / 全部收起」。
  每组展开按钮的可访问名称是「费用事件 No.x」，展开状态在 `aria-expanded`。
- 展开内容只用展开行自己的底色：先是一行「材料证据关联」（label-01 灰色标签加结论），多事件组再列各事件一行，
  下面是材料小表（文件与角色、识别为、校验、状态）。材料的校验文本已被结论完整说过时写「见材料证据关联」，不重复。
- 展开按钮的箭头：收起时朝右，展开时朝下（组行与表头的「全部展开」一样）。
- 待确认的行（组行与材料小表的行）左边一条 3px `$support-warning` 竖条，整行 `$notification-background-warning` 浅黄底，悬停时底色加深一档、竖条保留；
  状态列照样是警告标签，颜色只是第二通道。已排除的行文字用 `$text-secondary`。
- 摘要条里「需处理」大于 0 时值前带警告图标，「通过」带绿色 `$support-success` 对勾；图标不读屏，文字不变。
- 没有归入费用事件的材料单独一节，放在表格下方，用同样的材料小表。

### 标题与版式

- 标题下最多一句话，其余解释放进 Toggletip 或说明里。
- 不在标题前加小字眉题；不用全大写。
- 页头节奏由页头组件（PageHeader）统一：标题到导语 `$spacing-03`，页头到内容 `$spacing-07`。页面不再给页头或页头后的第一块内容写间距；
  页头右侧不放孤立的返回按钮，任务内往回走交给步骤条。
- 不用中点「·」把元信息拼成「A · B · C」一串，改用字段网格 `FieldGroup` 或详情列表 `DetailList`（见「版式统一」）；
  服务端给出的整句（如打印卡片页眉）照原样显示。
- 表格的 No. 列一律左对齐，列宽按内容收紧。
- 概览条（进行中 / 对账中 / 已交接 / 待你处理的计数）暂缓：任务列表契约里还没有这些字段。

## 不做的事

- 不用 Linear 品牌层（#5e6ad2、圆角、pill 标签），不打包 IBM Plex。
- 不加表格排序，不加批量操作栏。行选择只用在项目归属页（见「项目归属：勾选明细，点右侧项目归入」），行展开只用在材料盘点的费用事件表（见「盘点清单」）；
  其他表格都不加，以后逐项评审。
- 不写字面颜色；不引入第二个组件库或图标库。
- 不用 em-dash 和 en-dash；按钮上不加「→」。
