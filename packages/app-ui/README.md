# @baox/app-ui

本地报销应用的前端模块：新建报销任务、上传材料、材料盘点、待确认项、整单明细确认、打印稿预览、项目归属、ERP 填报、完成与对账。
Vite 7 + React 19 + TypeScript，只支持 Chrome，只做 zh-CN。视觉唯一来源是本目录的 [`DESIGN.md`](./DESIGN.md)。

以下命令都在仓库根目录执行，写作 `pnpm --filter @baox/app-ui <脚本>`；也可以在本目录直接 `pnpm <脚本>`。

## 开发

| 脚本 | 作用 |
| --- | --- |
| `dev` | 开发服务器，使用 HTTP 适配器连本地应用服务（`/api/...`，同源） |
| `dev:mock` | 开发服务器，使用浏览器内 mock 适配器与夹具，不需要任何服务 |
| `typecheck` | `tsc --noEmit` |

## mock 构建

`build:mock` 产出 `dist-mock/`：`index.html` 是单文件（脚本内联），示例原件在 `dist-mock/fixtures/`。
双击 `dist-mock/index.html`（`file://`）就能在 Chrome 里跑完整个模块，顶栏显示「模拟数据」。

正式构建 `build` 产出 `dist/`，由本地应用服务托管，不含 mock 代码、测试钩子与夹具（见 `check:dist`）。

## QA：`?seed=` 与 `?fault=`

参数写在 `#` 之前，例如 `dist-mock/index.html?seed=review&fault=service-disconnected#/task/T1/review`。
seed 只改主任务 T1（2026-08 上海出差，9 行明细合计 3972.59）；T2 固定在对账中，T3 固定为已完成。

| `?seed=` | T1 的状态 |
| --- | --- |
| `upload`（默认） | 还没有材料，显示拖拽区 |
| `inventory` | 11 份材料已盘点，结果按费用事件归组 |
| `pending` | 3 个待确认项未处理 |
| `review` | 待确认项已处理，9 行候选明细待勾选确认 |
| `actions` | 整单明细已确认，出现「去打印」「去报销」 |
| `print` | 同 `actions`，且打印稿已生成（打开 `#/task/T1/print`） |
| `project` / `assign` | 项目归属进行中，No.1、No.2 已归入 P-2307 |
| `erp` | 项目归属已提交，ERP 填报待开始 |
| `done` | 草稿 BX20260911-0173，回读 9/9 一致 |
| `reconcile` | 保存步中止后的对账（原地等待） |

| `?fault=` | 表现 |
| --- | --- |
| `duplicate-upload` | 第二批起第一份可接收的文件被拒绝为「内容重复」 |
| `unsupported-material` | 盘点多出一个待确认项：`曹操出行_行程单.pdf` 版式不支持 |
| `erp-login-missing` | 「我已登录，继续」前两次提示「还没有检测到登录」，第三次通过；不会自动探测到登录 |
| `erp-write-aborted` | 保存步中止，进入对账（对账中断点未知，建议原地等待）；重新对账读到草稿后完成；ERP 填报页自动进入对账页 |
| `readback-mismatch` | 严格回读 No.8 读到 74.00（本地 47.00）：写入停下，自动进入完成页，差异行高亮、不显示完成态，只能「转人工」；转人工后完成页与任务列表都显示「已转人工」 |
| `service-disconnected` | 本地服务停一次：打开任务列表时立即（或打开任务页 0.3 s 后）出现全页横幅「本地服务未运行，请在终端重新执行 baox」；任务列表按退避自动重试，任务页期间动作在按钮旁失败；3 s 后恢复，横幅消失，列表出现、快照重新拉取 |

未知的 seed / fault 在控制台警告后忽略。mock 构建还在 `window.__baoxMock` 上挂了一个 e2e 用的钩子：
`advanceElsewhere(taskId)` 模拟「另一个窗口推进了任务、这边还没收到推送」，下一次带旧 `stepToken` 的动作会得到 409，
页面换上最新快照并提示「任务已在别处推进」。

## 测试

| 脚本 | 作用 |
| --- | --- |
| `test` | Vitest + Testing Library（jsdom）：契约与夹具、HTTP 响应形状、仓库、各页面交互 |
| `test:e2e` | 先 `build:mock`，再用 Playwright（`channel: 'chrome'`，需本机 Google Chrome）经 `file://` 打开 `dist-mock/index.html`；含 seed × 页面、fault 全矩阵。截图是产物，在 `test-results/`（已 gitignore），不是像素基线 |
| `check:dist` | 正式构建后检查 `dist/`：不许出现夹具人名、草稿号、`print-sheet.pdf`、`fixtures/`、mock 模块名与测试钩子 |

## 夹具与 token

- `fixtures`：用 HTML 模板经 headless Chrome 生成示例 PDF（带中文文本层）、出租车票照片、打印页图与合并 PDF，写入 `fixtures/generated/` 并校验（需 macOS 上的 Google Chrome 与 `sips`）。数据全部虚构，来源是 `fixtures/scripts/data.mjs`。`fixtures:verify` 只校验。
- `tokens`：从 `DESIGN.md` front matter 生成 `src/styles/tokens.css`（`--check` 只比对）。页面 CSS 只能引用这些自定义属性。

## 给服务端实现者：契约入口

- `@baox/app-ui/contract`（`src/contract/index.ts`）：zod schema 与由它推导的类型。四类接口：任务列表（`TaskListSchema`）、任务快照（`TaskSnapshotSchema`）、动作端点（输入 schema 与错误文案在 `actions.ts`）、事件流。
- `src/contract/http.ts` 的 `HTTP_ENDPOINTS`：每个适配器方法对应的方法、路径与请求体字段；动作名与 `ACTION_NAMES` 一致。
- 响应约定：成功 200 返回整份新快照；失败 `{ error: { code, message } }`（`message` 直接显示在按钮旁）；`stepToken` 过期返回 409 与 `{ error, snapshot }`（最新快照）。事件流为 SSE，`event: snapshot`，`data` 为整份快照；客户端断开后按 0.5 s 起翻倍、封顶 10 s 重连，恢复后重新拉取快照。
- 值：金额两位小数字符串，日期 `YYYY-MM-DD`，时间 `HH:MM`，ID 不透明。上传为 multipart（`files`；支付截图为 `voucherMaterialId` + `file`）。
- 验收样本：`src/mock/fixtures/`（各阶段快照）与 `fixtures/generated/`（原件、页图、PDF）。
