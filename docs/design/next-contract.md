# `baox next` 的 JSON 契约

> **状态：归档（2026-09-11）。** 本文描述模型调用 `baox next` 的契约（`speak` 原样念、`actor: model`、子 Agent 范围、在对话里提问），已被[本地报销应用](standalone-app.md)取代：消费方改为应用服务端和页面。仍保留的独有事实：`next` 输出骨架、`step.kind` 清单，以及应用服务端将沿用的 `stepToken` / `--after` / `--result` 协议。待 `packages/contract/src` 与服务端文档覆盖这些内容后删除。

模型在整个流程里**只调用两条命令**：

```bash
baox next --dir "<材料目录>"                      # 问：现在该做什么
baox next --after <stepToken> [--result <file>]  # 答：我做完了，这是结果
```

底层那 22 条命令仍然存在，供人手敲排障；模型不直接选用它们。

## 输出骨架

```jsonc
{
  "command": "next",
  "schemaVersion": 1,
  "identity": { "displayName": "刘明建", "account": "luo.liu" },  // 每次都带，绑错了会在下一句话暴露
  "task": { "taskId": "75dc9cbb4d", "sourceLabel": "resources", "sourceDir": "/abs/path" },
  "state": "image_awaiting_reading",
  "progress": { "phase": 4, "of": 10, "label": "材料整理" },
  "interaction": { "templateId": "materials.processing", "version": 1, "status": "processing" },
  "actor": "model",
  "stepToken": "9f3c1a…",       // 一次性，回传时必须带
  "step": { "kind": "…", /* 见下 */ },
  "speak": "接下来我要看两张票的图……",   // 原样念给用户
  "context": "…",                        // 只在用户追问时才用
  "blockedBy": [],
  "exit": 0
}
```

员工交互的完整约束见 [user-interaction-contract.md](./user-interaction-contract.md)。`interaction` 是内部追踪元数据，不展示给员工；`speak`、`step.prompt` 和内核渲染的表格才是员工可见内容。

`exit`：`0` 继续 / `2` 有硬阻塞，未解决不得继续。没有 `1` —— 内核自身异常才用 `1`，且带 `error`。

## `step.kind`

| kind | actor | 模型要做的唯一一件事 | 回传 |
|---|---|---|---|
| `run` | kernel | 原样执行 `step.argv`，不改一个字；若步骤启动报销专用 Chromium，执行后等待用户在新窗口登录 | `--after <token> --result <stdout落盘的文件>` |
| `read_images` | model | 默认对 `step.images[].absPath` 逐个用模型视觉看图，按 `step.schemaPath` 写读数文件，再执行 `step.argv` 提交 | 同上 |
| `extract_images` | model | 把内核已落盘的版本化请求交给 `extract-reimbursement-images`；先跑受管 OCR，缺字段或候选校验失败时再用模型视觉，再执行 `step.argv` | 同上 |
| `read_markdown` | model | 读取带行号 Markdown，按工单模板提取；核对主发票标题及金额标签，跨行/串列回看原件页，再执行 `step.argv` | 同上 |
| `ask_user` | model | **原样贴出 `step.prompt`**（内核把 `step.questions[]` 渲染好的一整块文本：≤4 题，每题 2–4 选项，可 `multiSelect`，末项恒为「其他」可自由输入），等用户在对话里回答，把答案誊进 `step.answersPath` | `--after <token> --result <答案json>` |
| `confirm_table` | user | 原样贴出 `step.table`（内核渲染好的定宽文本），请用户过目 | 认可 → `--after <token>`；指错 → 附 `--correction <file>` |
| `dispute` | model | 摆出 `step.evidence`（材料路径、机器读到的原文、清晰度），并派**干净上下文子 Agent** 只重读 `step.field`；把两次机器读数和用户的值一起摆给用户 | 用户拍板后回传终值 |
| `tell_user` | user | 只说 `speak`，等用户完成登录或材料缺项处置后再调 `next` | 无 result，直接再问一次 |
| `handoff` | — | 告诉用户状态变化，转 `step.skill` | 不回传 |
| `done` | — | 念完 `speak` 收工 | — |

## 关键字段

- **`step.argv`** 是完整命令行数组，模型**原样执行**。禁止拼接、改参、加参。**内核自己会拦下不在 argv 里的越权命令**（退出码 2，并记进 `logs/refused.jsonl`）——守卫在内核里，不在 Skill 声明的 hook 里，理由见 [ADR-0010](../adr/0010-kernel-side-command-guard.md)。
- **`stepToken`** 一次性。内核只接受它刚发出的那一个；不匹配就忽略回传、重发当前步骤。这是"不可跳步"的物理实现。
- **`speak` / `context`** 分离：`speak` 原样念（措辞是模型差异最大的地方，不交给模型组织）；`context` 只在用户追问时动用，并且只解释业务原因，不向员工暴露路径、命令、组件、内部状态或错误代码。
- **`identity`** 每次都带，用于在每条输出开头呈现"当前替谁报销"。
- **`blockedBy`** 是结构化的开放项数组，每项含 `kind` / `materialId` / `hint` / `resolvableBy`（`user` | `model` | `kernel`）。
  `evidence_ambiguous` 还保留 `references`，其中每个候选带 `materialId` / `fileName`，供待办表同时显示凭证与候选参考材料。

- `home_city_required` 首次先尝试通过位置 Adapter 获取城市级网络位置；成功时把它作为待确认参考，失败时直接请求员工填写。`ask_user` 只写入当前 `tenant + account` 的员工记忆；已经开始的任务还会把确认值冻结到任务快照。
- `profile_confirmation` 在新任务创建前展示报销人和常驻城市；员工回复「确认」继续，直接输入城市则覆盖默认值，再创建使用新城市快照的任务。首次没有城市时只走 `home_city_required`，不重复确认。
  材料、日期、金额分摊、常驻城市、项目、费用类别和费用项目在准备阶段汇总为唯一的最终 `preparation_confirmation` 表；项目选择提交后不再追加一次分类确认。

- `project_unassigned` 的 `step.argv` 只能是内核发出的 `select-task` 个人项目簿入口。页面提交时重新读取当前身份和可选集合；没有个人项目簿来源证据的全局旧选择不能自动合法化。

- 准备材料包的生成、字段充分、用户准备确认分别判断。准备确认绑定当前材料包摘要；确认后由内核自动进入报销系统，按 PDF/图片分组导入发票、固定选择“不生成费用明细”、填写完整明细并保存草稿。导入后的收票身份和三项金额必须逐票回读，任一步结果不确定就进入恢复态且不重试。
- 正式写入或恢复需要可接管的 Chromium 页面。普通默认浏览器没有 CDP 时，状态机会先发出启动专用 Chromium 的 `run` 步骤；Chrome 与 Edge 共用同一个 CDP 适配器，用户登录一次后身份探测、写入和回读复用该页面，不切换到 ego，也不为浏览器品牌分叉业务流程。
- `select-task` 页面提交是保存草稿的授权边界，不追加保存确认；保存结果未知不得自动重试。

## 纠正与来源

- 每个字段带 `source`：`vision`（模型抄的）/ `user`（用户口述并对照原件确认过）/ `kernel`（解析或算出来的）。
- `confirm_table` 收到 `--correction` 且值与机器读数不同时，**不直接采纳**，转 `dispute`。
- `dispute` 的三种收场：重读=用户值 → 采纳并说明；重读=原值 → 两读加用户值一起摆，用户拍板；重读=第三个值 → 明说该字段读不稳，以原件为准。
- 用户改动破坏守恒式时，内核算出缺口并指明还缺什么；补不齐整条落回 `unreadable` 成开放项。内核**绝不**倒推另外两个值。

## 子 Agent 的可用范围

- 可以外包：`kind: "run"` 且 `outsourceable: true` 的连续段（体检、浏览器探测、分类、查重）。
- 不可外包：`ask_user`、`confirm_table`、`tell_user`、`dispute` 的对话部分。
  理由只有一个而且够硬：**那一头是人**，子 Agent 那里没有用户，无头会话（`claude -p`）
  那里也没有。所以**无头运行不是 baox 支持的形态**，这几步只能在有人在场的会话里做。
  身边没有用户时，唯一正确的动作是**停下并说明**，不是替他答一个 —— 内核分辨不出
  一份答案出自用户之口还是模型之手，硬校验只挡得住不平的数，挡不住一个"正好也平"的编造。

## 问用户，就在对话里问

`ask_user` **不用任何提问工具**（Claude Code 的 `AskUserQuestion` 之类）：用户可以把它关掉，
别的 Agent 也未必有它，而「在对话里问一句」是哪里都有的。
实测记录见验证台账 V-46。

问题由**内核渲染**成一整块文本放在 `step.prompt` 里，模型原样贴出去，和 `confirm_table`
贴表格是同一套搬运：措辞、选项、编号、末项那个「其他」，都不交给模型组织
—— 选项少一个、顺序换一换，用户是察觉不到的。
`step.questions[]` 仍然带着，模型誊答案时要用里面的 `id`。
- `dispute` 里的"独立重读单个字段"**必须**用子 Agent —— 要的就是它那份干净上下文。
- 子 Agent 只跑 `baox next`，被 `maxTurns` 截断时换一个接着走，无需交接说明。
