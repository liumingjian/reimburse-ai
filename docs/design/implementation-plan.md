# baox 1.0.0 实施计划（交接件）

配套读：[state-machine.md](./state-machine.md)（状态清单与判据）、[next-contract.md](./next-contract.md)（`next` 输出契约）。
这两份是**规格**，本文是**施工顺序**。规格与本文冲突时，以规格为准。

接手的 Agent 先读 [AGENTS.md](../../AGENTS.md) 和 [ADR-0001](../adr/0001-skill-shell-deterministic-kernel.md)：
Skill 是壳，内核是唯一的业务事实来源，这一条在 1.0.0 里不变，只是被加强了。

> 所有编译、测试、真机验证走 `rexec` 发到用户的 mac 上跑。本机内存不够，不要在这里跑测试。

## 0. 这次改的是什么

一句话：**模型不再选择命令，只执行内核给的命令。**

0.9.x 里模型读 SKILL.md，自己决定下一条跑什么、参数怎么拼。这是模型质量差异唯一的入口，
真机 QA 的两个 bug（跳过看图、前台阻塞时无法转达地址）都是从这个入口进来的。
1.0.0 把决策整体搬进内核：模型只会 `baox next`，拿回一个 `step`，照做，交结果。

三处破坏性变更，合起来发 **1.0.0**：

1. 数据目录默认从 `~/Library/Application Support/baox/` 迁到 `~/.baox/`（`BAOX_HOME` 覆盖不变）。
2. `install-runtime` / `launch.mjs` / 版本闸整套删除，内核就地运行。
3. 版本闸的判据从**代码版本**改为**状态 `schemaVersion`**。

## 1. 施工批次

六批，每批一个 PR，按序做 —— 后一批依赖前一批的产物。每批都必须绿着合。

### 批次 1：就地运行，数据目录搬家

- 删 `kernel/bin/launch.mjs`、`kernel/src/version.mjs`，删 `baox.mjs` 里的 `install-runtime` 分支，
  删 `version_drift` / `downgrade_refused` / `runtime_not_installed` 三个状态及其全部文案。
- `kernel/src/paths.mjs`：`dataDir()` 三分支塌成一条 —— `process.env.BAOX_HOME || path.join(os.homedir(), '.baox')`。
- 三个 SKILL.md 里的入口从 `launch.mjs` 改成 `${CLAUDE_SKILL_DIR}/kernel/bin/baox.mjs`。
- **迁移**：`baox` 任何命令启动时，若 `~/.baox` 不存在而旧目录存在，整份 `cp -R` 过去（不是 move —— 旧目录留着，
  用户回滚 0.9.x 还能用），并在输出里说一句迁到哪了。迁移只做一次，做完在新目录写 `migrated-from.txt`。
- 验收：`~/.baox` 里能看到 `chrome-profile/`、`tasks/`、`logs/`；`BAOX_HOME=/tmp/x baox doctor` 落在 `/tmp/x`；
  旧目录仍然完好。

### 批次 2：状态判定函数（纯函数，先不接 CLI）

- 新增 `kernel/src/state.mjs`，导出 `determineState(observation) -> { state, actor, blockedBy }`。
  **它必须是纯函数**：入参是一个已经采集好的观测对象，不读文件、不发网络请求。
  状态名与判据一字不改地照 [state-machine.md](./state-machine.md) 的两张表实现。
- 采集观测的那部分单独放 `kernel/src/observe.mjs`，它才碰文件系统和 CDP。
- 分层是硬要求：状态机的测试要能在没有 Chrome、没有材料目录的机器上跑完。
- 验收：`kernel/test/state.test.mjs` 覆盖全部 26 个状态各至少一例，外加**判定顺序**用例
  （两张表 7 + 19 行，对应 25 条判定规则加上兜底的 `env_ready`。`archived` 曾经也列在表里，
  已认定为任务状态而非状态，划掉了，见 state-machine.md）
  —— 同时满足多个判据时先报哪个（越靠前的表项优先，`schema_too_new` 永远最先）。

### 批次 3：`next` 与 `stepToken`

- 新增 `kernel/src/next.mjs`：`determineState` 的结果 → `step`。七种 `step.kind` 各一个构造函数。
- `stepToken`：随机 16 字节 hex，连同它对应的 `state` 一起写进任务状态文件；**一次性**。
  `--after <token>` 与在册的不符就**忽略回传、重发当前步骤**，不报错、不惩罚 —— 这是"不可跳步"的物理实现，
  不是给模型的告诫。
- `baox next --dir <目录>` 与 `baox next --after <token> [--result <文件>] [--correction <文件>]` 两条入口。
- `speak` / `context` 的文案**全部写死在内核里**，不留给模型组织。
- 验收：`kernel/test/next.test.mjs` —— 幂等（连着调三次 `next --dir` 拿到同一个 state 和同一个 token）；
  旧 token 被忽略；模型声称完成不推进状态（无 `--result` 的 `--after` 对 `kind: "run"` 无效）。

### 批次 4：纠正与争议

- `--correction` 的值与机器读数不同时**不直接落库**，转 `reading_disputed`。
- `dispute` 的 `step.evidence` 带：材料绝对路径、机器读到的原文、清晰度判断。
- 三种收敛结果（重读与用户一致 / 重读与原读数一致 / 重读给出第三个值）各自的措辞写死在内核。
- 用户的改动打破守恒式时，内核算出差额并说明还差什么；填不上就整条读数退回 `unreadable` 作为待办
  —— **内核永远不反算另外两个值**。
- 每个字段带 `source`：`vision` | `user` | `kernel`。
- 验收：`kernel/test/dispute.test.mjs` 覆盖三种收敛 + 守恒破坏 + `source` 的写入。

### 批次 5：Skill 壳收敛

- 用户入口只留 `baox` 一个。`baox-setup` 与 `baox-recover` 加 `disable-model-invocation: false` /
  `user-invocable: false`，改为模型调用，由主会话协调。
- 三份 SKILL.md 重写：删掉所有"接下来做什么"的判断逻辑（那些现在归内核），只留
  ①怎么念 `speak` ②七种 `step.kind` 各该做什么 ③什么不能做。目标长度：每份 ≤120 行。
- `confirm-readings` 的本地页面下线，改走终端表格（`confirm_table`）。本地页面只在
  **重新绑定身份**和**浏览完整项目目录**两处保留。
- 验收：`skills/baox/SKILL.md` 里不再出现除 `baox next` 以外的任何命令示例。

### 批次 6：hooks 与发布

- ~~`skills/baox/SKILL.md` frontmatter 加 `hooks.PreToolUse`~~ —— **实测不生效，见上面第 4 节。**
  实际落地的是内核里的守卫 `kernel/src/guard.mjs`；`hooks/guard.mjs` 保留为可选外层，改挂
  `.claude/settings.json`。
- 放行的规矩是**两条**，不是一条：`baox next`（外加 `erp-reconcile` 这一个例外——`handoff` 那一步
  不带 argv，拦掉它写入善后就此不通），以及内核**刚刚**放进 `step.argv` 的那一条完整命令行。
  按字面只放行 `next` 会让 `kind: "run"` 那一步当场停摆。其余一律拒（退出码 2 + 结构化 JSON），
  并记进 `logs/refused.jsonl`。
- 版本提到 `1.0.0`，`schemaVersion` 定为 `1`，更新 `docs/adr/`（新增一条 ADR 记 `next` 状态机；
  在 ADR-0002 补记本地页面收窄到两处）。
- 验收：见下面的"真机待验"。

## 2. 删除清单

删干净，不留兼容层 —— 留着就会有第二条路径，而这次改动的全部意义就是只剩一条路径。

| 删什么 | 为什么 |
|---|---|
| `kernel/bin/launch.mjs` | 就地运行后无处可转交 |
| `kernel/src/version.mjs` + 它的测试 | 版本闸移到 `schemaVersion` |
| `baox.mjs` 的 `install-runtime` 分支 | 不再有安装这回事 |
| `baox-setup` 步骤 2 整节、`version_drift` / `downgrade_refused` 表格行 | 同上 |
| `confirm-readings` 的本地页面渲染 | 改终端表格 |
| 三份 SKILL.md 里所有分支判断的散文 | 归内核 |

`kernel/src/serve.mjs` 的自动弹窗（#50）**保留**，重新绑定身份和项目目录页仍然要它。

## 3. 不要动的东西

- 数据目录里的 `chrome-profile/`、`tasks/`、`logs/`：不删、不清、不重建。
- 用户已登录的那个 Chrome 窗口：不关、不导航。
- CDP 调试端口永远只指向 baox 自己的 profile，绝不指向用户日常 Chrome。
- 探针不得持久化 URL 查询串（`_cnneptstate_` 带会话态）。
- baox 永远不代填 ERP 账号密码。
- `CONTEXT.md` 只是术语表，不写实现细节。
- 用户域和项目域两种安装位置都要能用；不要把"删掉另一份"写成政策。

## 4. 真机待验（两项，只能在 mac 上确认）

1. ~~**Skill 声明的 hooks 在项目域是否真的硬拒。**~~ **已实测，结论：不生效**（2026-09-07，
   Claude Code 2.1.263）。frontmatter 里的 `hooks` 被静默忽略——守卫被调起 0 次，被拦的命令照跑不误；
   同一个脚本挂到 `.claude/settings.json` 上则拦得住。于是走了这里预备的退路：守卫做进内核自身。
   判据也跟着改了——`CLAUDE_SKILL_DIR` 根本不在 Bash 工具的环境里，单认它等于守卫永远不生效，
   改取 `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` / `CLAUDE_SKILL_DIR` / `AI_AGENT` 的并集。
   见 [ADR-0010](../adr/0010-kernel-side-command-guard.md) 与
   [skill-declared-hooks.md](../research/skill-declared-hooks.md)。
2. ~~**终端多选（`AskUserQuestion`）在非交互 / `--print` 模式下的行为。**~~ **已实测，结论：不挂载**
   （2026-09-07，Claude Code 2.1.263）。`claude -p` 与 `-p --input-format stream-json` 两种无头形态的
   `system/init` 工具清单里都没有 `AskUserQuestion`，所以 `ask_user`、`confirm_table` 和 `dispute`
   的对话部分在无头会话里执行不了。**由此定下更干脆的一条：这个工具整个不用**——用户可以把它关掉
   （本仓库的主人就关了），别的 Agent 也未必有它，而「在对话里问一句」是哪里都有的。`ask_user` 改成
   由内核把问题渲染成一整块文本（`step.prompt`，`renderQuestions`），模型原样贴出、把用户的回答誊回来，
   和 `confirm_table` 贴表格同一套搬运。**降级到本地页面不做**：无头会话多半根本没有人在，弹一个
   没人点的页面只是把卡住换个地方发生。剩下"没人在场时不许代答"这一条只能靠说明书——同一轮量到
   **没有任何环境变量能可靠区分有头和无头**（`CLAUDE_CODE_ENTRYPOINT` 在 `-p` 里干脆不出现，
   而它出现的那一轮同样是无头的），内核判不了，文档里如实这么写。
   见 [terminal-questions-headless.md](../research/terminal-questions-headless.md)。

## 5. 完成的判据

- ~~全量测试绿（当前基线 122 例，新增的不少于 40 例）。~~ **达标**：321 例全绿（在 mac 上跑）。
- 用真实的 `resources/` 材料从零走通一遍：环境准备 → 分类 → 看图读数 → 终端确认 → 事件 → 选项目 → 核对 → 写入。
  **前两程已在真机上验过**（2026-09-07，见台账 V-47）：干净数据目录 + 真实 `resources/`，`next` 报
  `env_chrome_down` 并给出完整 `step.argv`，连问三次状态与 `stepToken` 都不变（幂等）；原样执行那条
  argv 起专用 Chrome 成功，状态跃迁到 `env_identity_unknown` 交给人。**从登录往后没验**——那一段
  每一步都要人：登录、看图读数要模型在交互式会话里、终端确认要人过目、写入要人点头。
  **这一条仍未关闭，1.0.0 不能凭它已发版就当作验收过了。**
- 全程模型只出现过 `baox next` 这一条命令；hook 日志里没有被拒的调用。
  **前两程为真**：那次真机跑动里 `logs/refused.jsonl` 始终不存在（一次被拒调用都没有）。整程同样未验。
- 用户手动登录**一次**，此后不再需要打开任何浏览器页面（除非重绑身份或浏览项目目录）。**未验**，
  同样卡在登录之后那一段。

> 后三条要的是一次有人在场的真机跑动，只能由用户本人在 mac 上做。能自动化的部分已经做完并记进
> 台账（V-46、V-47）；剩下的清单见 [真机验收清单](../qa/1.0.0-acceptance.md)。
