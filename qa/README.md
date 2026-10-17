# 浏览器 QA 驱动（操作手册）

`qa/run.mjs` 用真实 Chrome 把本机跑着的报销应用从登录一路走到 去报销，一边走一边记问题；
`qa/dump.mjs` 单独打印当前任务的逐份识别结果。

它是**操作员工具，不进 CI**：要一个真在跑的本机应用、一个真浏览器，还要你自己的材料。
`pnpm test` / `pnpm test:e2e` 都不会跑它。

## 1. 起本机应用

```bash
pnpm install
pnpm --filter @baox/web build          # 页面要先构建，服务端才同源提供它
pnpm --filter @baox/server build
BAOX_DATA_DIR=~/.baox-qa \
BAOX_PORT=4319 \
node server/dist/main.mjs              # 输出 listening on http://127.0.0.1:4319
```

用 `BAOX_DATA_DIR` 指一个**专给 QA 用的数据目录**：驱动会作废遗留的未完成任务，别指着日常数据。
第一次启动后在页面上创建管理员 `admin / admin123`（或用下面的 `QA_USER` / `QA_PASSWORD` 换成你自己的）。

### 1a. Dev mode for the maintainer's QA→fix loop (agents, through rexec)

When the maintainer asks for QA on the Mac, start this instead of the production build above: server under `tsx watch`
plus Vite, on the same persistent `~/.baox-qa`, so a fix reaches the open page without a rebuild and the maintainer's
tasks survive. Run from the worktree root:

```bash
rexec 'qa/dev.sh up'              # blocks until ready, prints: dev-mode QA instance ready: http://127.0.0.1:5173/
rexec 'qa/dev.sh sync'            # after each fix: pushes the changed files, lists them
rexec 'qa/dev.sh down'            # when the maintainer is done
```

`up` returns as soon as the page answers: the instance runs in a process group of its own with its output in log files,
so the rexec job ends and does not hold the workspace. The first `up` in a fresh checkout installs dependencies, which
can take minutes; give that Bash call a long timeout, or split it as `rexec --background 'qa/dev.sh up'` then
`rexec wait <ID>`.

**The dev instance drives the ERP differently from production.** `dev-main.ts` sends ERP write (去报销) jobs through
the CDP executor into a dedicated Chromium it launches itself (`BAOX_ERP_CHROMIUM`). The production build (`main.ts`,
§1 above, and the intranet deploy) sends them to the paired browser extension (浏览器扩展) in the employee's own browser.
The fill steps are the same executor code, but pairing, the extension's confirmation prompts, the employee browser's
session and cookies, and the extension transport are not exercised in dev mode. QA of those goes through the
production-build launch in §1 with the extension loaded and paired.

**Dev mode never reaches the 本地执行器 either.** `dev-main.ts` wires only the CDP executor, and the server adds the
暂存 step (`draft`, `server/src/erp/remote-executor.ts`) only to jobs it sends to a paired 本地执行器. So in dev mode a
去报销 never 暂存s and never ends in ERP 草稿已交接, and the 本地执行器's pairing, hosted ERP 凭据, install command
and self-update are not exercised. QA of those needs the production build with a 本地执行器 paired to it (ADR-0033,
ADR-0035). Say so before the maintainer starts a QA round on one of them.

- Hand the maintainer the Vite URL (`:5173`). The server's own `:4319` also serves `web/dist` when one was built, and that copy is stale.
- A pushed web file hot-reloads the page; a pushed server file restarts only the server (`tsx watch`), which re-opens the
  same data directory. A changed `package.json` or lockfile makes `sync` reinstall and restart the whole instance.
- `rexec` alone does not update the instance: it runs from its own copy of the tree (`~/.baox-qa-dev/src`), because the
  Mac's rsync re-stamps every synced file and the watchers would restart everything on each call. `qa/dev.sh sync` copies
  only files whose bytes changed.
- Logs: `~/.baox-qa-dev/server.log`, `~/.baox-qa-dev/web.log`; `qa/dev.sh status` says what runs. The instance is not a
  rexec job, so `rexec --cancel` cannot stop it; `qa/dev.sh down` does, and `up` replaces whichever instance is running.
- Server env passes through at `up`, e.g. `rexec --background 'BAOX_ERP_STOP_BEFORE_IMPORT=1 qa/dev.sh up'`. Overrides are listed at the top of `qa/dev.sh`.

The project-book section enters explicit numbers and names offline, including `P-2307` and `P-3312`, and checks duplicate and unsafe-number feedback. No ERP session or catalog fixture is needed to reach project assignment and whole-list confirmation. The administrator section uses a separate `QA-PUBLIC` number so it does not silently convert a member's personal entry.

`P-2307` 与 `P-3312` **只是离线夹具号**：真报销系统里没有这两个项目，报销信息核对会（正确地）说查不到。
所以凡是要真打到报销系统的那几段（项目归属之后的报销信息核对、去报销），必须用 `QA_PROJECT` /
`QA_PROJECT_NAME` 给一个**你这个账号真有的**项目，例如
`QA_PROJECT=111705 QA_PROJECT_NAME='安徽省农村信用社联合社-开源软件运维人员驻场服务-25-111705'`
（这是维护者账号的项目簿里真有的一个，换个账号就未必有——驱动不会替你猜，也没有默认值）。
给了之后，`project-book` 那一段会把它一起录进个人项目簿，`assignment` 把全部明细归到它名下。

不给 `QA_PROJECT` 时驱动照跑，但会在 `erp-project` 记一条 `WARN`，明说这一趟用的是离线夹具号、
去报销会停在报销信息核对那一步、发票无忧助手根本打不开——那不是应用的缺陷，是这一趟没配项目号。

## 2. 驱动认的环境变量

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `QA_BASE` | `http://127.0.0.1:4319` | 应用地址 |
| `QA_MATERIALS` | `/Users/lmj/Documents/temp/baox-resources` | 上传的材料目录（只挑 `.pdf/.jpg/.jpeg/.png`） |
| `QA_OUT` | `/tmp/baox-qa-artifacts` | 截图与 `findings.json` 的落地目录 |
| `QA_USER` / `QA_PASSWORD` | `admin` / `admin123` | 登录账号 |
| `QA_HOME_CITY` | `广州` | 新建任务的常驻城市 |
| `QA_PROJECT` | 空（回落到离线号 `P-2307`） | 归属与去报销用的项目号，要填**你这个报销系统账号真有的**项目 |
| `QA_PROJECT_NAME` | 同 `QA_PROJECT` | 该项目在报销系统里的名称，报销信息核对连名称一起比 |
| `QA_HEADLESS` | 空 | 置 `1` 则无头运行（冒烟用；平时就该看着它跑） |
| `QA_SKIP` | 逗号分隔的分区名，跳过不跑。例如 `QA_SKIP=erp-write` 可以跳过去报销那一段。 | 空 |

## 3. 跑一遍

```bash
pnpm exec node qa/run.mjs              # 浏览器有头，慢放 80ms，全程可旁观
pnpm exec node qa/dump.mjs             # 需要逐份看识别结果时
open /tmp/baox-qa-artifacts            # 截图与 findings.json
```

终端最后会打印 `=== summary: N defects, M warnings ===`；`findings.json` 是同一份记录的结构化版本。
`DEFECT` 是应用的问题，`WARN` 是需要人看一眼的地方。新发现的问题各开各的 issue。

只想冒烟一下、不想动自己的发票，就拿仓库里的合成材料跑一遍（另起端口与数据目录，不碰日常那份）：

```bash
mkdir -p /tmp/baox-qa-mats && cp fixtures/generated/m*.pdf /tmp/baox-qa-mats/
BAOX_DATA_DIR=/tmp/baox-qa-smoke BAOX_PORT=4399 \
BAOX_ERP_CHROMIUM=off node server/dist/main.mjs &
# 首次启动要先建管理员：页面上建，或
curl -s -X POST localhost:4399/api/auth/setup -H 'content-type: application/json' \
  -d '{"username":"admin","password":"admin123"}'
QA_BASE=http://127.0.0.1:4399 QA_MATERIALS=/tmp/baox-qa-mats QA_HEADLESS=1 pnpm exec node qa/run.mjs
```

合成材料里有两张铁路客票，而铁路发票类型还没有对应的报销系统发票类型，所以冒烟跑到 去报销 会被
`erp_preflight` 先挡下来——驱动会记成 WARN 并说明「没走到浏览器那一关」。真正的「ERP 浏览器关着」
这一关要用你自己的材料跑，见下一节。

## 4. 验「ERP 浏览器关着时，去报销要先停下来」

去报销走的是专用 Chromium（CDP 端口默认 9333）。要看拒绝路径：

1. 退掉那个专用 Chromium（数据目录下 `chromium-profile/` 起的那个窗口），确认 9333 没人监听：
   `lsof -nP -iTCP:9333 -sTCP:LISTEN`；
2. 起服务端时加 `BAOX_ERP_CHROMIUM=off`，这样服务端不会替你把它重新拉起来；
3. 照常跑 `qa/run.mjs`，`erp-write` 这一段会点 去报销，然后等快照里的 `erp.status`。

期望：`erp.status` 留在 `idle`，`erp.abortReason` 说得出是浏览器不可用，页面上也能看到这句话，
任务本身不被改动。驱动会把这几点分别记成 `ok` 或 `DEFECT`。

`erp-write` 这一段并不只管「浏览器关着」这一条路：它是整个驱动里唯一会点 去报销 的地方，专用浏览器
开着的时候，它点的就是一次真写入。写入走到底（`erp.status` 变 `done`，单据填好、交给本人自己按保存）
记 `ok`；预算用完还在 `running` 记 `WARN`（实测一次真写入约 141 秒，预算 300 秒）；只有 `aborted`
——也就是写入结果不确定——才是 `DEFECT`。

`erp.status` 一个字段不够看：报销信息核对不通过时，快照里的 `erp.status` 是**故意**留在 `idle` 的
（`server/src/task-snapshot/erp.ts`），问题都写在快照的 `catalog` 一节里。驱动两节一起读：看到 `catalog`
里有理由充分的拒绝，就照着理由记 `ok`（并另记一条 `WARN` 说这一趟没走到「浏览器关着」那条路），
**不会**记成 `DEFECT`——**服务端有理由的拒绝不是缺陷**。只有 `idle` 且哪儿都没有拒绝理由，才是缺陷。

一次干净的中止（写入之前就停了）同样**不会**把 `erp.status` 变成 `aborted`：它留在 `idle`，理由写在
`erp.abortReason` 里，只有「写没写进去说不准」的 `unknown` 才报 `aborted`。盯着 `status` 等，等到的就是这一节
本来要验的那种情况被记成缺陷。驱动现在读 `abortReason`，一出现就收尾，不再空耗剩下的预算。

## 7. 实机验证勾选时，别把那一次不可逆的点击花掉

```bash
BAOX_ERP_STOP_BEFORE_IMPORT=1        # 起服务端时设上
```

上传和勾选是免费且可重复的（ADR-0025），**发票导入单据 那一下不是**：它把发票绑到一张 费用报销单 上，而 QA 跑批
根本不会去保存那张单。设了这个变量，去报销会在上传、勾选全部完成之后、点 发票导入单据 之前停下，记
`IMPORT_STOPPED_BEFORE_BOUNDARY`。它**故意**停在 `startAttempt` 之前，所以任务仍是干净的 `aborted`，可重试也可作废。

不设就是原来的行为，员工那边什么都没变。

## 5. 住宿三件套（`stay-trio` 分区）

盘点结束后、处理待确认项之前，`stay-trio` 分区核对住宿报销的三件套（发票、结账单、支付截图，#213）：

- 每个缺件的待确认项，标题都要说出缺的是哪一件、是哪份材料的，否则记 `DEFECT`；
- 发票和结账单配上对的住宿发票不应该有缺结账单的待确认项，缺件却没有待确认项同样记 `DEFECT`；
  支付截图那一项每张住宿发票都有，传齐并点「已传齐」之前一直未处理（#331）；
- 缺支付截图的那一项，驱动会在待确认项页上传一张 1x1 PNG，确认这一项在上传后仍未处理，再点「已传齐」，确认这一项处理完毕。

合成材料里的 m01 发票与 m02 结账单能配对、没有支付截图，冒烟跑一遍就能走到上传这一步。

## 6. 待确认项是怎么填的

- 填什么由 `qa/values.mjs` 决定。它先看字段声明的 `format`（`money` / `date` / `time` / `text`，
  从 `GET /api/tasks/:id` 的 `pendingItems[].fields[].format` 读到），读不到才退回按标签猜。
  金额一律是两位小数、非负、无千分位、且不为 `0.00`，就是应用自己那套校验
  （`contract/src/actions.ts`）收得下的形状。
- 金额还要**自己对得上**：`不含税金额 + 税额 = 价税合计`（`server/src/kind-policy.ts`）。驱动先从快照里
  拿这份材料已经读到的价税合计，再按它拆出另外两项；价税合计本身也缺的时候，三项一起用同一个替身金额
  拆。服务端不会倒算（ADR-0017），所以填进去的数必须本来就守恒。
- 发票号码按材料 id 生成，两份材料不会拿到同一个号——否则应用会（正确地）说它们是同一张发票。
  项目名称填的是 `*税收分类*说明` 这个形状，应用要靠它判费用类别；认不出的材料没有行程单，
  永远取不到费用发生城市，所以替身用的是住宿类。
- 保存被拒时，驱动会拿应用自己的规则复核一遍它刚填的值：自己这边说得通就记 `DEFECT`，
  说不通（比如替身值本来就满足不了某条校验）就记 `WARN` 并写明是哪条校验。**服务端有理由的拒绝不是缺陷。**
- 每个待确认项最多试 3 次（`MAX_ATTEMPTS_PER_ITEM`），答不上来就留给人，接着处理队列里别的项，
  不会在一项上空转；选择类连环打开新表单的链路也有深度上限。
- 跑完若还有没解决的项，日志里会列出来，并留下 `pending-stuck` 截图。

不开浏览器也能检一下取值逻辑（`qa/values.mjs`）与驱动那几处不碰浏览器的判断（`qa/checks.mjs`：
用哪个项目号、`idle` 的 ERP 视图该怎么读、旋转要等多久）——同样不在 CI 里：

```bash
node --test "qa/*.test.mjs"
```
