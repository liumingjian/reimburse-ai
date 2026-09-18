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

The project-book section enters explicit numbers and names offline, including `P-2307` and `P-3312`, and checks duplicate and unsafe-number feedback. No ERP session or catalog fixture is needed to reach project assignment and whole-list confirmation. The administrator section uses a separate `QA-PUBLIC` number so it does not silently convert a member's personal entry.

For later ERP checks against demonstration project numbers, the existing optional catalog fixture remains available:

```bash
BAOX_PROJECT_CATALOG_FIXTURE=$PWD/server/src/catalog/testing/projects.fixture.json
```

This fixture does not make local intake ERP-verified. The operator-only ERP sections retain their existing session and environment requirements.

## 2. 驱动认的环境变量

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `QA_BASE` | `http://127.0.0.1:4319` | 应用地址 |
| `QA_MATERIALS` | `/Users/lmj/Documents/temp/baox-resources` | 上传的材料目录（只挑 `.pdf/.jpg/.jpeg/.png`） |
| `QA_OUT` | `/tmp/baox-qa-artifacts` | 截图与 `findings.json` 的落地目录 |
| `QA_USER` / `QA_PASSWORD` | `admin` / `admin123` | 登录账号 |
| `QA_HOME_CITY` | `广州` | 新建任务的常驻城市 |
| `QA_HEADLESS` | 空 | 置 `1` 则无头运行（冒烟用；平时就该看着它跑） |
| `QA_SKIP` | 逗号分隔的分区名，跳过不跑。例如 `QA_SKIP=erp-off` 可以跳过去报销那一段。 | 空 |

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
BAOX_PROJECT_CATALOG_FIXTURE=$PWD/server/src/catalog/testing/projects.fixture.json \
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
3. 照常跑 `qa/run.mjs`，`erp-off` 这一段会点 去报销，然后等快照里的 `erp.status`。

期望：`erp.status` 变成 `aborted`，`erp.abortReason` 说得出是浏览器不可用，页面上也能看到这句话，
任务本身不被改动。驱动会把这三点分别记成 `ok` 或 `DEFECT`。

## 5. 住宿三件套（`stay-trio` 分区）

盘点结束后、处理待确认项之前，`stay-trio` 分区核对住宿报销的三件套（发票、结账单、支付截图，#213）：

- 每个缺件的待确认项，标题都要说出缺的是哪一件、是哪份材料的，否则记 `DEFECT`；
- 三件都齐的住宿发票不应该有这类待确认项，缺件却没有待确认项同样记 `DEFECT`；
- 缺支付截图的那一项，驱动会在待确认项页直接上传一张 1x1 PNG，确认这一项随之消失。

合成材料里的 m01 发票与 m02 结账单能配对、没有支付截图，冒烟跑一遍就能走到上传这一步。

## 6. 待确认项是怎么填的

- 填什么由 `qa/values.mjs` 决定。它先看字段声明的 `format`（`money` / `date` / `time` / `text`，
  从 `GET /api/tasks/:id` 的 `pendingItems[].fields[].format` 读到），读不到才退回按标签猜。
  金额一律是两位小数、非负、无千分位、且不为 `0.00`，就是应用自己那套校验
  （`contract/src/actions.ts`）收得下的形状。
- 金额还要**自己对得上**：`不含税金额 + 税额 = 价税合计`（`server/src/parse/kinds.ts`）。驱动先从快照里
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

不开浏览器也能检一下取值逻辑（同样不在 CI 里）：

```bash
node --test "qa/*.test.mjs"
```
