# @baox/app-ui

本地报销应用的前端模块：新建报销任务、上传材料、材料盘点、待确认项、项目归属、整单明细确认、打印稿预览、ERP 填报、完成与对账。
流程顺序照 Skill 的实际运行顺序：待确认项 → 项目归属（含报销事由）→ 报销信息核对 → 报销材料准备 → 唯一一次整单明细确认 → 去打印 / 去报销。
Vite 7 + React 19 + TypeScript，只支持 Chrome，只做 zh-CN。视觉唯一来源是本目录的 [`DESIGN.md`](./DESIGN.md)。

以下命令都在仓库根目录执行，写作 `pnpm --filter @baox/app-ui <脚本>`；也可以在本目录直接 `pnpm <脚本>`。

## 开发

| 脚本 | 作用 |
| --- | --- |
| `dev` | 开发服务器，使用 HTTP 适配器连本地应用服务（`/api/...`，同源） |
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

## QA：个人项目簿

顶栏的「个人项目簿」与任务侧栏的「维护个人项目簿」都进入全局页面 `#/projects`（不在启动门内，随时可进）。页面照内核 `project-book-page.mjs`：只有「项目号」一个输入框，
「核验并加入」由服务端先做安全字符校验（`^[A-Za-z0-9_-]{1,64}$`），再核对当前登录身份，再到报销系统核验，名称只取核验回读值；同号再次录入即覆盖，没有编辑，也不开放过期日。
表头「项目号 | 名称 | 过期时间 | 状态」，状态（可选 / 已过期 / 复检未通过 / 项目号不安全）与说明由服务端给出；每行可「删除」，另有「复检全部」「清理全部失效」。结果文案照内核（「ERP」写作「报销系统」）。

mock 的项目簿只在内存里（刷新后回到夹具）。默认 6 条：P-2307、P-2311、P-3312、P-1180 可选，P-4420 已过期，P-0917 复检未通过。录入按 mock 报销系统项目目录核验：

| 项目号 | 核验结果 |
| --- | --- |
| `P-5108`、`P-6021`（及默认项目簿里的号码） | 通过，带回名称（苏州门店巡检、年度预算评审…） |
| `P-0917` | 不可引用（unusable） |
| `P-7700` | 对上 2 条记录（ambiguous） |
| `P-9000` | 查询没有完成（query_failed） |
| 其他安全号码 | 查不到（missing） |
| 含空格、分号等字符 | 项目号不安全，服务端拒绝（unsafe） |

| 选项 | 表现 |
| --- | --- |
| `?book=empty` | 项目簿初始为空。任务走到项目归属时（例如 `?seed=pending&book=empty` 处理完待确认项，或直接 `?seed=project&book=empty`），项目归属页换成「先维护个人项目簿」维护入口；第一次录入成功后自动回到项目归属，并能选到这个项目 |
| `?erp=logged-out` | 在启动页点顶栏「个人项目簿」：页面照常打开并说明还没登录，项目簿为空；录入被拒绝，显示「没有已核对的报销系统身份…」 |

项目归属页右栏的「去维护项目簿」链接是对 Skill 的小增强（Skill 的项目归属页没有跳转，只能明确要求维护）；维护后回到项目归属，允许列表已按新项目簿更新。

## QA：新建任务与全流程

- 任务列表的「新建报销任务」在列表上打开弹层（`#/tasks/new` 是它的深链，取消回到 `#/tasks`）。弹层只有报销人（只读）与常驻城市：
  没有名称和日期，任务名称由服务端生成，创建时是占位名 `<日期> 新建报销`，盘点结束后按材料日期与城市改名（示例材料得到 `2026-08 上海出差`）并给出费用期间。
- 常驻城市的默认值由服务端给出：第一次是网络位置候选「杭州」（说明「根据网络位置推测…」）；创建过任务后是这个报销人身份上次确认的城市（按账套 + 登录账号持久记住，刷新页面后仍预填，说明「上次确认的常驻城市…」）。
  `?location=unavailable` 模拟位置获取失败：第一次打开时常驻城市留空，提示直接填写。它不是故障场景，可与 seed/fault 同用。
- 全流程：新建任务后把 `dist-mock/sample-materials/` 里的 11 份文件一起拖进上传区，开始材料盘点，得到 3 个待确认项（两张出租车票、一张餐饮发票）。
  处理完进入项目归属（为每条明细选项目并填写报销事由）；提交后服务端自动核对报销信息、准备报销材料（本票是占位，各约 0.6 s 自动通过），
  再进入唯一一次整单明细确认。确认后「去打印」进入打印稿预览；「去报销」直接启动浏览器，登录后自动写入，没有「开始填报」。
  mock 按业务文件名或示例原件文件名（`m01-hotel-invoice.pdf` 等）识别材料；其他文件成为「不支持的材料类型」待确认项。
- 统一业务序号（整单确认表 No.、打印稿页序、ERP 明细行与回读表）由服务端给出，跟随内核确认表的分类排序：本地市内交通 → 外地市内交通 → 长途交通 → 住宿，
  同一分类内按事件顺序。示例材料得到 No.1-3 高德、No.4 曹操、No.5-6 出租车、No.7-8 铁路、No.9 住宿，合计 3972.59。
- 整单确认绑定项目归属：确认后在项目归属页改派项目或改事由，确认失效并提示重新确认。支付截图只在打印稿页的住宿页补充。

## QA：`?seed=` 与 `?fault=`

参数写在 `#` 之前，例如 `dist-mock/index.html?seed=review&fault=service-disconnected#/task/T1/review`。
seed 只改主任务 T1（2026-08 上海出差，9 行明细合计 3972.59）；T2 固定在对账中，T3 固定为已完成。seed 按流程顺序：

| `?seed=` | T1 的状态 |
| --- | --- |
| `upload`（默认） | 还没有材料，显示拖拽区 |
| `inventory` | 11 份材料已盘点，结果按费用事件归组 |
| `pending` | 3 个待确认项未处理 |
| `project` / `assign` | 待确认项已处理，项目归属进行中，No.1、No.2 已归入 P-2307；整单确认页还不能进 |
| `catalog` | 项目归属已提交，正在核对报销信息（占位，约 0.6 s 后自动进入材料准备） |
| `preparation` | 正在准备报销材料（占位，约 0.6 s 后自动进入整单确认） |
| `review` | 9 行候选明细（项目归属已提交）待勾选确认 |
| `actions` | 整单明细已确认，出现「去打印」「去报销」 |
| `print` | 同 `actions`，且打印稿已生成（打开 `#/task/T1/print`） |
| `erp` | 已点「去报销」：浏览器已启动、等待登录；点「我已登录，继续」后自动写入 |
| `done` | 草稿 BX20260911-0173，回读 9/9 一致 |
| `reconcile` | 保存步中止后的对账（原地等待） |

| `?fault=` | 表现 |
| --- | --- |
| `duplicate-upload` | 第二批起第一份可接收的文件被拒绝为「内容重复」 |
| `unsupported-material` | 盘点多出一个待确认项：`曹操出行_行程单.pdf` 版式不支持 |
| `erp-login-missing` | 「我已登录，继续」前两次提示「还没有检测到登录」，第三次通过；不会自动探测到登录 |
| `erp-write-aborted` | 保存步中止，进入对账（对账中断点未知，建议原地等待）；重新对账读到草稿后完成；ERP 填报页自动进入对账页 |
| `readback-mismatch` | 严格回读 No.6（出租车）读到 74.00（本地 47.00）：写入停下，自动进入完成页，差异行高亮、不显示完成态，只能「转人工」；转人工后完成页与任务列表都显示「已转人工」 |
| `service-disconnected` | 本地服务停一次：打开任务列表时立即（或打开任务页 0.3 s 后）出现全页横幅「本地服务未运行，请在终端重新执行 baox」；任务列表按退避自动重试，任务页期间动作在按钮旁失败；3 s 后恢复，横幅消失，列表出现、快照重新拉取 |

未知的 seed / fault / location / erp / identity / book 在控制台警告后忽略。mock 构建还在 `window.__baoxMock` 上挂了一个 e2e 用的钩子：
`advanceElsewhere(taskId)` 模拟「另一个窗口推进了任务、这边还没收到推送」，下一次带旧 `stepToken` 的动作会得到 409，
页面换上最新快照并提示「任务已在别处推进」。

## 测试

| 脚本 | 作用 |
| --- | --- |
| `test` | Vitest + Testing Library（jsdom）：契约与夹具、HTTP 响应形状、仓库、各页面交互 |
| `test:e2e` | 先 `build:mock`，再用 Playwright（`channel: 'chrome'`，需本机 Google Chrome）经 `file://` 打开 `dist-mock/index.html`；含全流程（`e2e/flow.spec.ts`）、seed × 页面、fault 全矩阵。截图是产物，在 `test-results/`（已 gitignore），不是像素基线 |
| `check:dist` | 正式构建后检查 `dist/`：不许出现夹具人名、草稿号、`print-sheet.pdf`、`fixtures/`、`sample-materials`、mock 模块名与测试钩子，也不许有 `fixtures/`、`sample-materials/` 目录 |

## 夹具与 token

- `fixtures`：用 HTML 模板经 headless Chrome 生成示例 PDF（带中文文本层）、出租车票照片、打印页图与合并 PDF，写入 `fixtures/generated/` 并校验（需 macOS 上的 Google Chrome 与 `sips`）。数据全部虚构，来源是 `fixtures/scripts/data.mjs`（打印页顺序与页眉跟随统一业务序号）。`fixtures:verify` 只校验。
- `tokens`：从 `DESIGN.md` front matter 生成 `src/styles/tokens.css`（`--check` 只比对）。页面 CSS 只能引用这些自定义属性。

## 给服务端实现者：契约入口

- `@baox/app-ui/contract`（`src/contract/index.ts`）：zod schema 与由它推导的类型。四类接口：任务列表（`TaskListSchema`）、任务快照（`TaskSnapshotSchema`）、动作端点（输入 schema 与错误文案在 `actions.ts`）、事件流。
- `src/contract/http.ts` 的 `HTTP_ENDPOINTS`：每个适配器方法对应的方法、路径与请求体字段；动作名与 `ACTION_NAMES` 一致。`start-erp-write` 就是「去报销」（整单确认之后，`choose_action` 下接受），之后没有别的开始确认。
- 启动：`TaskListSchema` 的 `erpSession` 与 `employee.binding` 决定启动页（`startupComplete`）。启动动作不属于任务：`POST /api/startup/recheck-erp-session`（「我已登录」，只再探测）与 `POST /api/startup/confirm-identity`（`account`、`tenant`，回传页面上看到的身份，服务端重读后对不上即拒绝）；成功返回整份任务列表，失败 `{ error, taskList? }`。未完成启动时服务端拒绝新建任务。常驻城市按身份（tenant + account）持久记忆。
- 个人项目簿（`contract/project-book.ts`）：`GET /api/project-book` 返回 `ProjectBook { projects: [{ number, name, expiresOn, lastCheckedAt, selectable, statusLabel, statusNote }] }`（身份没核对通过时为空）；
  `POST /api/project-book/intake`（`number`）、`/remove`（`number`）、`/purge`、`/recheck`。服务端处理了请求就 200 返回 `{ status, verdict, note, book }`（`status` 照内核：admitted / rejected / not_logged_in / identity_mismatch / query_failed / removed / not_found / purged / none / done / empty，文案见 `PROJECT_BOOK_NOTES`），请求本身失败 `{ error, book? }`。
  项目簿一变，还没开始写入报销系统的任务经事件流拿到新的允许列表。流程门：进入项目归属时没有可选项目、也没有归属，step 为 `maintain_project_book`（页面换成维护入口），第一次录入成功后回到 `assign_projects`。
- 流程与阶段：`TASK_STAGES` 的顺序即流程（`stage.ts`）；`project` 之后服务端自动经过 `catalog`、`preparation` 进入 `review`。整单确认的 `digest` 绑定项目归属与事由，改派后确认记为 `invalidated`（`PROJECT_CHANGED_NOTICE`）。
- 响应约定：成功 200 返回整份新快照；失败 `{ error: { code, message } }`（`message` 直接显示在按钮旁）；`stepToken` 过期返回 409 与 `{ error, snapshot }`（最新快照）。事件流为 SSE，`event: snapshot`，`data` 为整份快照；客户端断开后按 0.5 s 起翻倍、封顶 10 s 重连，恢复后重新拉取快照。
- 值：金额两位小数字符串，日期 `YYYY-MM-DD`，时间 `HH:MM`，ID 不透明。上传为 multipart（`files`；支付截图为 `voucherMaterialId` + `file`，只在打印稿生成后接受）。
- 验收样本：`src/mock/fixtures/`（各阶段快照）与 `fixtures/generated/`（原件、页图、PDF）。
