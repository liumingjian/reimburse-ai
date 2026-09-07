---
name: baox
description: 报销。Use when the user wants to start, continue, or ask about a reimbursement from a folder of invoices and itineraries. This is the only baox entry point a user ever needs — environment setup and write recovery are dispatched from here.
allowed-tools: Bash, Read, Task
---

# baox

用户看到的一切都是中文。English is for this file only.

**你只会敲一条命令。** 内核决定下一步做什么，你照做，把结果交回去：

```bash
node "${CLAUDE_SKILL_DIR}/kernel/bin/baox.mjs" next --dir "<材料目录>"
```

第一次问要带 `--dir`；此后回传用 `--after <stepToken>`，**内核会把完整命令行放在
`step.argv` 里，你原样执行**。底层还有二十来条子命令，那些是给人手敲排障的，不是给你选的。

## 怎么念内核的话

- **`speak` 原样念给用户**，一个字不改、不概括、不补充。措辞是内核写死的。
- `context` 只在用户追问「为什么」时才动用。不追问就不念。
- 每轮开头带一句 `identity.displayName`（在替谁报销）和 `progress`（第几步 / 共几步）。
- `blockedBy` 里的每一项都要说到，别只说「还有几个问题」。
- 有 `ignored` 键说明你上一次回传没被收下，念出 `ignored.note`，别装作过去了。
- `exit`：`0` 继续 / `2` 硬阻塞，念完停下，不要绕过去 / `1` 内核自己出错，念 `error` 后停。

## 七种 `step.kind`

| kind | 你做的唯一一件事 | 回传 |
|---|---|---|
| `run` | 原样执行 `step.argv`，stdout 落盘成一个文件 | `next --after <token> --result <那个文件>` |
| `read_images` | 逐个用 `Read` 打开 `step.images[].absPath`，按 `step.schemaPath` 那份模板把读数写进 `step.readingsPath`，再原样执行 `step.argv` | 同上 |
| `ask_user` | 用终端多选问 `step.questions[]`，答案按 `step.answersFormat` 写进 `step.answersPath` | `next --after <token> --result <答案文件>` |
| `confirm_table` | **原样贴出 `step.table`**，请用户对着原件过目 | 认可 → `next --after <token>`；指错 → 把用户的值按 `step.correctionFormat` 写进 `step.correctionPath`，再 `next --after <token> --correction <那个文件>` |
| `dispute` | 摆出 `step.evidence`，并派一个**干净上下文的子 Agent** 只重读 `step.field`，两次机器读数和用户的值一起摆给用户 | 用户拍板后按 `speak` 里说的回传 |
| `tell_user` | 只念 `speak`，等用户自己动手（登录、去 ERP 保存）。做完再问一次 | 不带 result，直接 `next --after <token>` |
| `handoff` | 告诉用户状态变了，转 `step.skill`（模型调用，用户不用知道有这个 skill） | 不回传 |
| `done` | 念完 `speak` 收工 | — |

`read_images` 的抄写纪律在 `references/image-reading.md`，看图之前先读它。

## 什么时候派子 Agent

`step.outsourceable` 是 `true` 的连续几步（体检、起 Chrome、探测、盘点、分类、查重——
也就是整个环境准备）可以整段派给子 Agent，让主会话不被那些 JSON 占满。子 Agent 的任务就一句：
**只跑 `baox next`，照 `step` 做，一直做到 `outsourceable` 变成 `false` 或者 `exit` 不是 0 为止，
然后把最后那一份 JSON 原样带回来。** 它被 `maxTurns` 截断就再派一个接着走，不需要交接说明——
状态在内核里，不在子 Agent 的上下文里。

`outsourceable: false` 的步骤**不能外包**：那一头是人（终端多选、终端表格、要人亲手点一下的本地页面），
子 Agent 那里没有用户。`dispute` 里的「独立重读那一个字段」是唯一的例外，而且**必须**外包——
要的就是它那份不知道我们刚才争过什么的干净上下文。

## 不能做的事

- **不拼命令、不改参数。** `step.argv` 原样执行，多一个参数少一个参数都不行。
  除 `next` 以外的 `baox` 子命令你一条都不敲。
- **不替内核判断下一步。** 状态在内核里。你不因为「看起来该分类了」就去分类。
- **不替用户点头。** 「没问题」「对的」「继续」在对话里说出来不是确认。确认只有一种：
  内核观测到的那一次回传。这条管 `confirm_table`、`ask_user` 和所有 `tell_user`。
- **不算数、不凑数。** 不推导、不平均、不按比例、不把差额抹到某一段上。守恒式不平就是不平。
- **不猜、不编。** 看图时你是抄写员：读不出就写进 `unreadable`，猜一个值比说读不出坏得多。
- **不说「我看不到图片」**，除非 `Read` 真的报了错——那就原样引用那条错误并说是哪个文件。
  没打开过就不知道打不打得开。
- **不重放已经发出去的 ERP 写入。** 落没落地不清楚的时候，当它落了。
- **不改用户的材料目录。** 内核只读它，你更不动它。
- **不代填 ERP 账号密码。**
