# `baox next` 的 JSON 契约

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
  "progress": { "phase": 3, "of": 10, "label": "看图读数" },
  "actor": "model",
  "stepToken": "9f3c1a…",       // 一次性，回传时必须带
  "step": { "kind": "…", /* 见下 */ },
  "speak": "接下来我要看两张票的图……",   // 原样念给用户
  "context": "…",                        // 只在用户追问时才用
  "blockedBy": [],
  "exit": 0
}
```

`exit`：`0` 继续 / `2` 有硬阻塞，未解决不得继续。没有 `1` —— 内核自身异常才用 `1`，且带 `error`。

## `step.kind` 七种

| kind | actor | 模型要做的唯一一件事 | 回传 |
|---|---|---|---|
| `run` | kernel | 原样执行 `step.argv`，不改一个字 | `--after <token> --result <stdout落盘的文件>` |
| `read_images` | model | 对 `step.images[].absPath` 逐个用 `Read` 看图，按 `step.schemaPath` 写读数文件，再执行 `step.argv` 提交 | 同上 |
| `ask_user` | model | **原样贴出 `step.prompt`**（内核把 `step.questions[]` 渲染好的一整块文本：≤4 题，每题 2–4 选项，可 `multiSelect`，末项恒为「其他」可自由输入），等用户在对话里回答，把答案誊进 `step.answersPath` | `--after <token> --result <答案json>` |
| `confirm_table` | user | 原样贴出 `step.table`（内核渲染好的定宽文本），请用户过目 | 认可 → `--after <token>`；指错 → 附 `--correction <file>` |
| `dispute` | model | 摆出 `step.evidence`（材料路径、机器读到的原文、清晰度），并派**干净上下文子 Agent** 只重读 `step.field`；把两次机器读数和用户的值一起摆给用户 | 用户拍板后回传终值 |
| `tell_user` | user | 只说 `speak`，等用户做完（登录、去 ERP 保存）后再调 `next` | 无 result，直接再问一次 |
| `handoff` | — | 告诉用户状态变化，转 `step.skill` | 不回传 |
| `done` | — | 念完 `speak` 收工 | — |

## 关键字段

- **`step.argv`** 是完整命令行数组，模型**原样执行**。禁止拼接、改参、加参。**内核自己会拦下不在 argv 里的越权命令**（退出码 2，并记进 `logs/refused.jsonl`）——守卫在内核里，不在 Skill 声明的 hook 里，理由见 [ADR-0010](../adr/0010-kernel-side-command-guard.md)。
- **`stepToken`** 一次性。内核只接受它刚发出的那一个；不匹配就忽略回传、重发当前步骤。这是"不可跳步"的物理实现。
- **`speak` / `context`** 分离：`speak` 原样念（措辞是模型差异最大的地方，不交给模型组织）；`context` 只在用户追问时动用。
- **`identity`** 每次都带，用于在每条输出开头呈现"当前替谁报销"。
- **`blockedBy`** 是结构化的开放项数组，每项含 `kind` / `materialId` / `hint` / `resolvableBy`（`user` | `model` | `kernel`）。

## 纠正与来源

- 每个字段带 `source`：`vision`（模型抄的）/ `user`（用户口述并对照原件确认过）/ `kernel`（解析或算出来的）。
- `confirm_table` 收到 `--correction` 且值与机器读数不同时，**不直接采纳**，转 `dispute`。
- `dispute` 的三种收场：重读=用户值 → 采纳并说明；重读=原值 → 两读加用户值一起摆，用户拍板；重读=第三个值 → 明说该字段读不稳，以原件为准。
- 用户改动破坏守恒式时，内核算出缺口并指明还缺什么；补不齐整条落回 `unreadable` 成开放项。内核**绝不**倒推另外两个值。

## 子 Agent 的可用范围

- 可以外包：`kind: "run"` 的连续段（体检、起 Chrome、探测、分类、查重）。
- 不可外包：`ask_user`、`confirm_table`、`tell_user`、`dispute` 的对话部分。
  理由只有一个而且够硬：**那一头是人**，子 Agent 那里没有用户，无头会话（`claude -p`）
  那里也没有。所以**无头运行不是 baox 支持的形态**，这几步只能在有人在场的会话里做。
  身边没有用户时，唯一正确的动作是**停下并说明**，不是替他答一个 —— 内核分辨不出
  一份答案出自用户之口还是模型之手，硬校验只挡得住不平的数，挡不住一个"正好也平"的编造。

## 问用户，就在对话里问

`ask_user` **不用任何提问工具**（Claude Code 的 `AskUserQuestion` 之类）：用户可以把它关掉，
别的 Agent 也未必有它，而「在对话里问一句」是哪里都有的。
实测记录见 [terminal-questions-headless.md](../research/terminal-questions-headless.md)。

问题由**内核渲染**成一整块文本放在 `step.prompt` 里，模型原样贴出去，和 `confirm_table`
贴表格是同一套搬运：措辞、选项、编号、末项那个「其他」，都不交给模型组织
—— 选项少一个、顺序换一换，用户是察觉不到的。
`step.questions[]` 仍然带着，模型誊答案时要用里面的 `id`。
- `dispute` 里的"独立重读单个字段"**必须**用子 Agent —— 要的就是它那份干净上下文。
- 子 Agent 只跑 `baox next`，被 `maxTurns` 截断时换一个接着走，无需交接说明。
