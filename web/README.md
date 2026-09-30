# @baox/web

本地报销应用的前端模块：新建报销任务、上传材料、材料盘点、待确认项、项目归属、整单明细确认、打印稿预览、保存报销草稿（写入报销系统）、完成与对账，以及全局的个人项目簿与设置（完全重置）。
员工可见文案遵守内核禁用词（`FORBIDDEN_USER_TERMS`）：界面写「报销系统」不写 ERP，不说「候选」，阶段名用内核 10 阶段。
流程顺序照 Skill 的实际运行顺序：待确认项 → 项目归属（含报销事由）→ 报销信息核对 → 报销材料准备 → 唯一一次整单明细确认 → 去打印 / 去报销。
Vite 7 + React 19 + TypeScript，只支持 Chrome，只做 zh-CN。视觉唯一来源是本目录的 [`DESIGN.md`](./DESIGN.md)。

以下命令都在仓库根目录执行，写作 `pnpm --filter @baox/web <脚本>`；也可以在本目录直接 `pnpm <脚本>`。

## 开发

| 脚本 | 作用 |
| --- | --- |
| `dev` | 开发服务器，使用 HTTP 适配器连本地应用服务：Vite 把 `/api`（含 SSE）代理到 `127.0.0.1:${BAOX_PORT:-4319}`。根目录 `pnpm dev` 同时启动服务端（`tsx watch`）与本页面 |
| `dev:mock` | 开发服务器，使用浏览器内 mock 适配器与夹具，不需要任何服务 |
| `typecheck` | `tsc --noEmit` |

## mock 构建

`build:mock` 产出 `dist-mock/`：`index.html` 是单文件（脚本内联），示例原件在 `dist-mock/fixtures/`，
另有一份可直接拖进上传区的 `dist-mock/sample-materials/`（同样 11 份原件，按业务文件名命名，如 `全季酒店_发票.pdf`；对照表是 `fixtures/sample-materials.json`）。
双击 `dist-mock/index.html`（`file://`）就能在 Chrome 里跑完整个模块，顶栏显示「模拟数据」。

正式构建 `build` 产出 `dist/`，由本地应用服务托管，不含 mock 代码、测试钩子、夹具与示例材料（见 `check:dist`）。

## QA：启动（登录报销系统与确认报销人身份）

任何任务之前先完成启动：任务列表接口给出 `erpSession`（`logged_in` / `not_logged_in`）与 `employee`（姓名、登录账号、账套、`binding`）。
没完成时任务列表、新建弹层与任务页一律换成启动页（地址不变，完成后原地进入）。默认场景已登录、身份已登记，直接进入任务列表。

| 选项 | 表现 |
| --- | --- |
| `?erp=logged-out` | 先显示「登录报销系统」；点「我已登录」只请服务端再探测，mock 第一次即通过，随后进入身份确认（此前已确认过则直接进入任务列表） |
| `?identity=unbound` | 显示「确认报销人身份」表（姓名 / 登录账号 / 账套，只能确认）；确认后进入任务列表，刷新后不再询问 |
| `?identity=mismatched` | 整页阻塞「报销人身份不一致」，没有任何按钮 |

mock 把身份登记与常驻城市写进 `localStorage`，按账套 + 登录账号分键，所以刷新后仍在；要重看 `?identity=unbound`，清除这个页面的站点数据即可。
报销人只显示姓名，没有部门（内核身份里没有这一项）。

## QA: project books

The personal project book (个人项目簿) is available at `#/projects`. Enter a project number (项目号) and project name in “项目号” and “项目名称”, then select “加入项目”. Intake is offline: names are entered manually, and local availability does not represent an ERP check. The existing pre-import ERP checks still apply.

Rows offer “编辑”, “停用”, and “恢复” according to their lifecycle state. Editing retains proposed input on failure; cancellation writes nothing. Deactivated entries stay visible and reserve their numbers. Duplicate intake never replaces an existing entry. Only the owning account maintains its personal entries; different owners can use the same personal number independently.

Every signed-in member can view the complete public project book (公共项目簿) on the same page. Administrators maintain it at `#/admin`. Active and inactive public entries reserve their numbers against personal intake, renumbering, and restoration. A public creation or renumbering that matches personal entries first requests explicit conversion confirmation. Cancel changes nothing; confirmation consolidates matching personal entries for future use while preserving submitted task snapshots.

Open assignment views receive updated choices after maintenance. Previously submitted number, name, and source remain historical snapshots. Maintenance offers neither ERP-derived name correction nor destructive bulk cleanup.

Mock entries are development fixtures, scoped to the fixture account; new accounts start with empty personal books. Mock books live in memory and reset on reload. Production has no default project catalog. Use `?book=empty` to exercise the empty-book assignment gate. Intake leaves the gate open until the user selects “项目录完了，开始归属”. The assignment panel's “新增项目” dialog uses the same form and preserves selected lines when closed.

## QA：新建任务与全流程

- 任务列表的「新建报销任务」在列表上打开弹层（`#/tasks/new` 是它的深链，取消回到 `#/tasks`）。弹层只有报销人（只读）与常驻城市：
  没有名称和日期，任务名称由服务端生成，创建时是占位名 `<日期> 新建报销`，名称之后不变（同服务端），盘点结束后给出费用期间。
- 常驻城市的默认值由服务端给出：第一次是网络位置候选「杭州」（说明「根据网络位置推测…」）；创建过任务后是这个报销人身份上次确认的城市（按账套 + 登录账号持久记住，刷新页面后仍预填，说明「上次确认的常驻城市…」）。
  `?location=unavailable` 模拟位置获取失败：第一次打开时常驻城市留空，提示直接填写。它不是故障场景，可与 seed/fault 同用。
- 全流程：新建任务后把 `dist-mock/sample-materials/` 里的 11 份文件一起拖进上传区，开始材料盘点，得到 4 个待确认项（两张出租车票、一张餐饮发票，以及住宿发票缺支付截图）。
  处理完进入项目归属（为每条明细选项目并填写报销事由）；提交后直接进入唯一一次整单明细确认（报销信息在去报销的作业里核对）。
  确认后「去打印」进入打印稿预览；「去报销」直接启动浏览器，登录后自动写入，没有「开始填报」。
  mock 按业务文件名或示例原件文件名（`m01-hotel-invoice.pdf` 等）识别材料；其他文件成为「不支持的材料类型」待确认项。
- 统一业务序号（整单确认表 No.、打印稿页序、报销系统明细行与回读表）由服务端给出，跟随内核确认表的分类排序：本地市内交通 → 外地市内交通 → 长途交通 → 住宿，
  同一分类内按事件顺序。示例材料得到 No.1-3 高德、No.4 曹操、No.5-6 出租车、No.7-8 铁路、No.9 住宿，合计 3972.59。
- 整单确认表照内核 `preparationConfirmationTable`：No. 加 13 列（发票 | 项目号 | 起始日期 | 结束日期 | 住宿地/城市 | 出发点 | 目的地 | 费用分类 | 费用项目 | 发票类型 | 费用金额 | 税额 | 总额，
  列名常量 `CONFIRMATION_TABLE_COLUMNS`），无组标题、无合计行，表内不展示文件名；表下「材料包」一节写文件数并列出材料包文件（#114 要求），文件名只出现在这一节，整页没有「参考材料」字样（行程单、结账单在材料包里的类别名是「证明材料」）。只能「确认」，有不对的地方回到对应步骤修改。
- 整单确认绑定项目归属：确认后在项目归属页改派项目或改事由，确认失效并提示重新确认。支付截图在住宿发票的待确认项里上传，打印稿预览页不补充。

## QA：`?seed=` 与 `?fault=`

参数写在 `#` 之前，例如 `dist-mock/index.html?seed=review&fault=service-disconnected#/task/T1/review`。
seed 只改主任务 T1（2026-08 上海出差，9 行明细合计 3972.59）；T2 固定在对账中，T3 固定为已完成。seed 按流程顺序：

| `?seed=` | T1 的状态 |
| --- | --- |
| `upload`（默认） | 还没有材料，显示拖拽区 |
| `inventory` | 11 份材料已盘点，结果按费用事件归组 |
| `pending` | 4 个待确认项未处理（含住宿发票缺支付截图：可在这一项上直接上传支付截图，或选「确认没有支付截图」） |
| `project` / `assign` | 待确认项已处理，项目归属进行中，No.1、No.2 已归入 P-2307（「归入项目」面板的「本次已归入」显示 2 条 / 47.54 元）；整单确认页还不能进 |
| `review` | 9 行整单明细（项目归属已提交）待「确认」 |
| `actions` | 整单明细已确认，出现「去打印」「去报销」 |
| `print` | 同 `actions`，且打印稿已生成（打开 `#/task/T1/print`） |
| `erp` | 已点「去报销」：浏览器已启动、等待登录；点「我已登录，继续」后自动写入 |
| `done` | 草稿 BX20260911-0173，回读 9/9 一致，完成页显示固定句「报销草稿已保存。请打开报销系统检查，是否提交由你决定。」 |
| `reconcile` | 交接步中止后的对账，还没对过账（对账中断点「尚未判定」：「开始对账」或「转人工」） |

| `?fault=` | 表现 |
| --- | --- |
| `duplicate-upload` | 第二批起第一份可接收的文件被拒绝为「内容重复」 |
| `unsupported-material` | 盘点多出一个待确认项：`曹操出行_行程单.pdf` 版式不支持 |
| `catalog-mismatch` | 去报销的作业在报销信息核对这一步发现 P-2307 在报销系统里改了名（「改过名的项目」），导入之前停下：任务回到项目归属，显示问题；把用到 P-2307 的明细改到别的项目后重新提交，回到整单确认 |
| `erp-login-missing` | 「我已登录，继续」前两次提示「还没有检测到登录」，第三次通过；不会自动探测到登录 |
| `erp-write-aborted` | 交接步中止，自动进入对账页；还没对过账（对账中断点「尚未判定」：「开始对账」或「转人工」）；开始对账读到填好、逐行一致的单据后完成 |
| `readback-mismatch` | 填写明细后的严格回读对不上：写入停下，自动进入对账页，还没对过账（「开始对账」或「转人工」）。开始对账读到草稿 BX20260911-0173，No.6（出租车）的申请报销金额读到 74.00（本地 47.00）：差异行高亮；点「展开」看到「申请报销金额 本地 47.00 / 报销系统 74.00」与原因句。已保存但逐行不一致 ⇒ 转人工：显示人工核对固定句，只能「转人工」；转人工后任务列表显示「已转人工」 |
| `service-disconnected` | 报销服务停一次：打开任务列表时立即（或打开任务页 0.3 s 后）出现全页横幅「连不上报销服务，请检查网络后重试；如果一直这样，请联系维护者」；任务列表按退避自动重试，任务页期间动作在按钮旁失败；3 s 后恢复，横幅消失，列表出现、快照重新拉取 |

## QA：回读、对账、用语、重置与作废

- 写入进度照内核 erp-write 的阶段分 9 步：启动浏览器、登录、打开空白报销单、选择不生成费用明细、导入发票、收票回读、填写明细、保存草稿、严格回读。
- 严格回读逐行比对内核的 9 个字段（申请报销金额、项目、费用项目、开始日期、结束日期、费用金额、税额、收票单号、发票类型）。行上显示申请报销金额两边的值；
  不一致的行点「展开」列出对不上的字段（「字段 本地 X / 报销系统 Y」）与原因句。收票单号是虚构的 `SPD20260911000N`（按发票短标签编号）。
- 对账页只显示对账结果允许的处置：未知、未保存·导入前、未保存·就绪待保存、身份成立的已保存 ⇒ 原地等待（只有「重新对账」）；
  未保存·已导入未写明细、不自洽、逐行不一致或身份不成立的已保存 ⇒ 转人工（显示固定句「当前报销已暂停，材料和状态已保留。请在报销系统中核对；如无法判断，请联系报销管理员。」，只有「转人工」）。
  T2 是「已保存 + 逐行不一致」；`?seed=reconcile` / `?fault=erp-write-aborted` / `?fault=readback-mismatch` 停下后还没对过账（尚未判定，服务端同此），先「开始对账」。
- 阶段名用内核 10 阶段：任务列表徽标写「3/10 材料盘点」「6/10 项目归属」「10/10 草稿交接」等，任务页顶部是步骤条；对账中的任务仍写「对账中」（它是保存报销草稿里的停顿状态）。
- 任务列表每行有「作废」（任务菜单列）：还没开始写入报销系统的任务二次确认后从列表消失（内核作废是状态变更，工作区保留）；
  已开始写入报销系统的任务（T2、T3、`?seed=erp` 起的 T1）按钮不可用，旁边写原因「已开始写入报销系统，不能作废：它占用的发票要靠对账解除。」。
- 顶栏「设置」（`#/settings`，不在启动门内，身份不一致时也能打开）有「完全重置」：二次确认后清空本机任务、个人项目簿、身份登记与常驻城市，回到启动页（登录报销系统）；
  重新登录并确认身份后任务列表为空。内核 reset 在用户明确要求时不再二次确认；界面上的按钮加了一次确认，防止误点。

## QA：报销信息核对与材料准备

同服务端：报销信息核对在去报销的作业里做（`?fault=catalog-mismatch`），提交项目归属后直接进入整单确认，没有 `catalog` / `preparation` 两个阶段（它们不能作 seed）。
材料准备没有缺项、也没有材料包文件清单要显示，所以确认页不出现「准备缺项」表与「材料包」一节。
例如 `dist-mock/index.html?seed=actions&fault=catalog-mismatch#/task/T1/review`，点「去报销」。

mock 与服务端的对照见 `src/mock/parity.test.ts`：每个黄金快照场景都从新建任务起经 mock 的流程走一遍，快照整体比对（逐项列出比不了的字段与原因）。

## QA：逐段分摊、处理人与跨任务重复发票

- 待确认项逐条标明处理人（要你处理 / 我来处理 / 系统，照内核开放项表，由服务端给出）：清单每条写在文件名后，详情写「处理人：…」。示例材料的待确认项都是「要你处理」。
- 空文本 PDF 与多页发票也是「要你处理」，只能「排除此材料」，或在上传页追加原件后重新盘点。mock 把 0 字节或文件名含「空白」的 PDF 当作空文本 PDF，文件名含「多页」的 PDF 当作多页发票。
- 盘点页只保留进度与材料清单（文件 | 识别为 | 校验 | 状态），不显示读出的字段；待确认项页显示读出的字段，但不显示来源（规则名、`user`），两页都没有「候选」字样。

| 选项 | 表现 |
| --- | --- |
| `?allocation=1` | 高德合并发票的行程单三段合计 69.10，和票面价税合计 69.19 对不上：盘点多出第一个待确认项「合并交通发票逐段金额」，三段输入框预填行程单读数 26.69 / 20.85 / 21.56。直接提交得到服务端错误「各段加起来是 69.10 元，和票面价税合计 69.19 元对不上…」；第 3 段改成 21.65 后通过，明细与默认相同（9 行，3972.59）。也可以选「这张票我认不出」（照内核 `allocation_given_up`）：什么都不会被悄悄移走，逐段分摊项记为已处理，同时多出一条要你处理的阻塞项「逐段金额认不出」（说明照内核话术），它不能答复，其余四项处理完仍停在待确认项（还剩 1 个）。在这一项上点「排除这张发票及其行程单」后才进入项目归属，明细剩 6 行，合计 3903.40；另一条出路是在上传页追加列了逐段金额的行程单后重新盘点。例如 `dist-mock/index.html?seed=pending&allocation=1#/task/T1/pending`；与 `?seed=project` 及之后的 seed 同用时，逐段金额已按原件答复 |
| `?duplicate=1` | 跨任务查重（按发票身份）命中：上传示例材料（含 `铁路电子客票_0809.pdf`）并开始盘点后整批停。盘点页与待确认项页显示「重复发票」表（序号 \| 材料/明细 \| 参考材料 \| 待处理问题 \| 处理人）、命中的任务「2026-06 北京培训」（已完成的 T3）与处置说明；不划分费用事件、不形成待确认项，也进不了项目归属。出路照内核「把文件移出」：点「移出 铁路电子客票_0809.pdf」后阻塞解除（之后重新盘点也不再算它），接着形成 4 个待确认项，处理完明细是 8 行。例如 `dist-mock/index.html?duplicate=1#/task/T1/upload` |

未知的 seed / fault / location / erp / identity / book / catalog / preparation / allocation / duplicate 在控制台警告后忽略。mock 构建还在 `window.__baoxMock` 上挂了一个 e2e 用的钩子：
`advanceElsewhere(taskId)` 模拟「另一个窗口推进了任务、这边还没收到推送」，下一次带旧 `stepToken` 的动作会得到 409，
页面换上最新快照并提示「任务已在别处推进」。

## 测试

| 脚本 | 作用 |
| --- | --- |
| `test` | Vitest + Testing Library（jsdom）：契约与夹具、HTTP 响应形状、仓库、各页面交互；`src/copy.test.ts` 扫描文案常量、mock 给出的文字与源码中文文案里的内核禁用词 |
| `test:e2e` | 即根目录 `pnpm test:e2e`：先构建服务端、`dist/` 与 `dist-mock/`，再跑 Playwright 的两个项目（`channel: 'chrome'`，需本机 Google Chrome）。`server` 项目在 `e2e/server/`，每个测试经 `e2e/server/fixture.ts` 启动一个构建好的服务端（临时 `BAOX_DATA_DIR`、空闲端口，托管 `dist/`）；`mock` 项目是其余 spec，经 `file://` 打开 `dist-mock/index.html`，只保留真实服务端难以到达的状态；含从启动登录到完成的全流程（`e2e/journey.spec.ts`，上传 `sample-materials/`）、从待确认项起的流程顺序（`e2e/flow.spec.ts`）、seed × 页面、fault 全矩阵。截图是产物，在 `test-results/`（已 gitignore），不是像素基线 |
| `check:dist` | 正式构建后检查 `dist/`：不许出现夹具人名、单据编号、`print-sheet.pdf`、`fixtures/`、`sample-materials`、mock 模块名与测试钩子，也不许有 `fixtures/`、`sample-materials/` 目录 |

## 夹具与样式

- Fixtures live in the `@baox/fixtures` package (`fixtures/` at the repo root). `pnpm --filter @baox/fixtures generate` renders sample PDFs (with a Chinese text layer), taxi-receipt photos, print page images and the merged PDF from HTML templates through headless Chrome into `fixtures/generated/`, then verifies them (needs Google Chrome and `sips` on macOS); `verify` only checks. All data is fictitious; its source is `fixtures/scripts/data.mjs` (print page order and headers follow the unified business number).
- 样式：界面用 IBM Carbon（`@carbon/react` 组件，`@carbon/styles` Gray 10 原样主题，ADR-0012）。入口是 `src/styles/carbon.scss`（主题、系统字体、按组件引入的样式），
  本应用自己的版式规则在 `src/styles/_app-rules.scss`，只引用 Carbon 的 token。规则见 `DESIGN.md`；原先由 DESIGN.md 生成 `tokens.css` 的脚本已删除。

## 给服务端实现者：契约入口

- `@baox/contract`（`contract/src/index.ts`）：zod schema 与由它推导的类型。四类接口：任务列表（`TaskListSchema`）、任务快照（`TaskSnapshotSchema`）、动作端点（输入 schema 与错误文案在 `actions.ts`）、事件流。
- `contract/src/http.ts` 的 `HTTP_ENDPOINTS`：每个适配器方法对应的方法、路径与请求体字段；动作名与 `ACTION_NAMES` 一致。`start-erp-write` 就是「去报销」（整单确认之后，`choose_action` 下接受），之后没有别的开始确认。
- 启动：`TaskListSchema` 的 `erpSession` 与 `employee.binding` 决定启动页（`startupComplete`）。启动动作不属于任务：`POST /api/startup/recheck-erp-session`（「我已登录」，只再探测）与 `POST /api/startup/confirm-identity`（`account`、`tenant`，回传页面上看到的身份，服务端重读后对不上即拒绝）；成功返回整份任务列表，失败 `{ error, taskList? }`。未完成启动时服务端拒绝新建任务。常驻城市按身份（tenant + account）持久记忆。
- 个人项目簿（`contract/src/project-book.ts`）：`GET /api/project-book` 返回 `ProjectBook { projects: [{ number, name, expiresOn, lastCheckedAt, selectable, statusLabel, statusNote }] }`（身份没核对通过时为空）；
  `POST /api/project-book/intake`（`number`）、`/remove`（`number`）、`/purge`、`/recheck`。服务端处理了请求就 200 返回 `{ status, verdict, note, book }`（`status` 照内核：admitted / rejected / not_logged_in / identity_mismatch / query_failed / removed / not_found / purged / none / done / empty，文案见 `PROJECT_BOOK_NOTES`），请求本身失败 `{ error, book? }`。
  项目簿一变，还没开始写入报销系统的任务经事件流拿到新的允许列表。流程门照内核 `!selectionApplied && projectBook.empty`：还没提交过项目归属、项目簿又没有可选项目时，step 为 `maintain_project_book`（页面换成维护入口；上次留下的归属不影响这个判断），第一次录入成功后回到 `assign_projects`。允许列表因项目簿变动而变时换发 `stepToken`。
- 项目归属（`snapshot.ts` `ProjectAssignment`，照内核 Variant B）：`projects` 只含可选项目（不可选的不随快照给出）；`assignments` 是服务端记下的归属（整单确认绑定它），`working` 是本次正在编辑的归属，`usage` 是「本次已归入」区（`{ number, name, lineCount, grossTotal, selectable }`，条数与金额由服务端算好）。「归入」是动作 `assign-project-lines`（`lineIds`、`projectNumber`、`onlyUnassigned`、`stepToken`），只改 `working`（草稿也是服务端状态，每次都换发 `stepToken`），新的归属只能用可选项目；提交 `submit-project-assignment` 用当前可选集合重新校验，已删除或失效的项目不能用于新归属，但某条明细上次记下的就是它时可以沿用（`usage` 里 `selectable: false`，页面显示「已锁定」）。`Line` 另有 `route` 与 `maskedNumber`（内核 maskNumber），供明细卡片展示。
- 流程与阶段：`TASK_STAGES` 的顺序即流程（`stage.ts`）；`project` 之后服务端自动经过 `catalog`、`preparation` 进入 `review`。整单确认的 `digest` 绑定项目归属与事由，改派后确认记为 `invalidated`（`PROJECT_CHANGED_NOTICE`）。
- 报销信息核对与材料准备（`snapshot.ts`）：快照带 `catalog { status: pending | running | matched | mismatch, problems[] }` 与
  `preparation { status: pending | blocked | ready, problems[], packageFiles[] }`。不匹配时阶段停在 `catalog`、step 为 `assign_projects`（改派后重新提交即重新核对）；
  有缺项时阶段停在 `preparation`、step 为 `resolve_preparation`，缺项上 `excludableMaterialId` 不为空的，可用 `exclude-material`（`materialId`、`stepToken`）排除该材料，服务端随后重新准备。
  `exclude-material` 另外接受两种情形（见 `EXCLUDE_MATERIAL_ERRORS` 注释）：`given_up` 待确认项的发票（连同它的行程单排除），与重复发票阻塞项上的材料（移出本次材料后接着盘点）。
  材料包文件数只看 `packageFiles`（确认上不再另记）。表格列名常量：`CATALOG_MISMATCH_COLUMNS`、`PREPARATION_PROBLEM_COLUMNS`；进度与阻塞文案：`CATALOG_PREPARATION_COPY`。
- 严格回读（`snapshot.ts`）：`ReadbackRow { no, description, matched, fields: [{ label, local, erp, matched }], reasons[] }`，`fields` 覆盖 `READBACK_FIELD_LABELS` 的 9 个字段，
  一致与否、原因句都由服务端给出（description 与行级 matched 待服务端 spec 确认）。完成页的固定句是 `HANDOVER_COMPLETED_NOTICE`。
- 对账（`snapshot.ts` `Reconcile`）：`bucket` 是 `RECONCILE_BUCKETS` 六类之一，`action` / `actionCode` 是内核判定，`allowedActions` 是允许的处置（页面只渲染这些，服务端也只接受这些，
  否则 `action_not_allowed`），`humanReview` 为真时显示 `HUMAN_REVIEW_NOTICE` 且没有重新对账。`reasons` 只放不属于某一行的原因。
- 阶段名：`stage.ts` 的 `KERNEL_PHASES`、`TASK_STAGE_PHASES`、`TASK_STAGE_LABELS`（「N/10 阶段名」）与 `RECONCILE_STATUS_LABEL`。
  这是按任务阶段的粗粒度对应：待确认项阶段统一记 4/10 材料整理，不显示 5/10 划分费用事件（内核在同一阶段里两种都会发）；要精确显示需要服务端在快照里直接给阶段名，待服务端 spec 确认。
- 作废与重置（任务之外，返回整份任务列表，失败 `{ error, taskList? }`）：`POST /api/tasks/:id/abandon`、`POST /api/reset`。
  任务列表行带 `abandonable` 与 `abandonBlockedReason`（已开始写入报销系统的不能作废），文案见 `ABANDON_TASK_COPY`、`RESET_COPY`。
- 待确认项（`snapshot.ts`）：`PendingItem` 带 `resolver`（`RESOLVER_LABELS`：要你处理 / 我来处理 / 系统）；`kind` 为 `form` / `choice` / `allocation` / `given_up`。
  逐段分摊（内核 `allocation_required`）的 `allocation = { segments: [{ index, date, route, suggested }], total, giveUpNote }`，`answer-pending` 的 `answer` 为 `{ amounts: [...] }`（按段顺序，两位小数）或 `{ giveUp: true }`；
  是否按分守恒由服务端判定，不守恒返回 `{ error }`（文案 `ALLOCATION_ERRORS.notConserved`），页面只显示。「认不出」的后果由服务端写在 `giveUpNote`；照内核，放弃之后出现一条阻塞的 `given_up` 项（`why` 是后果说明），它不接受 `answer-pending`（`PENDING_ANSWER_ERRORS.notAnswerable`），只能用 `exclude-material` 排除这张发票，或追加材料后重新盘点。
- 跨任务重复发票（内核 `duplicate_blocked`）：快照 `blockers: [{ kind: 'duplicate_across_tasks', materialId, fileName, reason, resolver, tasks: [{ taskId, name }] }]`。有阻塞项时整批停：盘点结束但 `events`、`pendingItems` 为空，阶段停在 `inventory`，step 为 `none`。处置是 `exclude-material`（阻塞项的 `materialId`）：服务端把这份移出本次材料，阻塞解除后接着划分费用事件。表格列 `BLOCKER_TABLE_COLUMNS`，说明文案 `DUPLICATE_BLOCKER_COPY`。
- 响应约定：成功 200 返回整份新快照；失败 `{ error: { code, message } }`（`message` 直接显示在按钮旁）；`stepToken` 过期返回 409 与 `{ error, snapshot }`（最新快照）。事件流为 SSE，`event: snapshot`，`data` 为整份快照；客户端断开后按 0.5 s 起翻倍、封顶 10 s 重连，恢复后重新拉取快照。
- 值：金额两位小数字符串，日期 `YYYY-MM-DD`，时间 `HH:MM`，ID 不透明。上传为 multipart（`files`；支付截图为 `voucherMaterialId` + `file`；打印稿生成前只接受住宿三件套的发票）。
- 验收样本：`src/mock/fixtures/`（各阶段快照）与 `fixtures/generated/`（原件、页图、PDF）。
- mock 与服务端对照：`src/mock/parity.test.ts` 把服务端录制黄金快照（`@baox/contract/goldens`）的每个场景在 mock 里走一遍，
  逐项比对阶段、step、`allowedActions`、ERP 与对账处置等页面据以分支的字段。mock 流程改动让它失败时，改 mock 去跟服务端一致，不要改黄金快照。
