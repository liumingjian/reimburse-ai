---
name: baox
description: "报销。Use when the user wants to start, continue, or ask about a reimbursement from a folder of invoices and itineraries. This is the only baox entry point a user ever needs — environment setup and write recovery are dispatched from here."
allowed-tools: Bash, Read, Task, Skill
---

# baox

用户看到的一切都是中文。浏览器初始化、登录、读取失败或自动化 QA 时先读 `references/browser.md`；正式页面使用系统默认浏览器。
当前流程以准备材料包交接为终点，随后等待用户手动 QA。涉及材料包生成、充分性检查、准备确认或准备完成时，先读 `references/preparation.md`。
遇到 `ask_user`、`confirm_table`、`tell_user` 或 `dispute` 时，先读 `references/human-interaction.md`，按当前 step 的人机回传契约处理。
## 完全重置

用户明确要求重置或清空 baox 时，直接运行 `node "<这个 skill 目录的绝对路径>/kernel/bin/baox.mjs" reset`，不再要求确认。
若已分配 baox 专属 ego 空间，沿用它的 `BAOX_EGO_TASK_SPACE`；重置时不新建空间。
重置清除全部本地业务信息和历史迁移副本，关闭专属浏览器空间；保留程序、运行依赖、原始材料、共享登录态和 ERP 远端单据。
返回后原样念 `speak` 并停止；失败时按内核返回的原因处理。

## 报销流程

**你只会敲一条命令。** 内核决定下一步做什么，你照做，把结果交回去；项目簿为空时执行内核发出的 `projects-page` 维护入口，不自建项目号或 ERP 全局搜索命令：

```bash
node "<这个 skill 目录的绝对路径>/kernel/bin/baox.mjs" next --dir "<材料目录>"
```

`CLAUDE_SKILL_DIR` 环境变量**不存在**；路径使用这份 SKILL.md 所在目录的真实绝对路径。
第一次问要带 `--dir`；此后回传用 `--after <stepToken>`，**内核会把完整命令行放在
`step.argv` 里，你原样执行**。底层还有二十来条子命令，那些是给人手敲排障的，不是给你选的：
**内核会当场拒掉**（退出码 2，`status: "refused"`），并把这次拒绝记进日志。
撞上它不要换个写法再试，照实告诉用户你刚才想干什么。
## 怎么念内核的话

- **`speak` 原样念给用户**，一个字不改、不概括、不补充。措辞是内核写死的。
- **先念 `speak`，再执行 `step.argv`。** 顺序反过来会真的伤到人：有的命令会弹出一个本地页面
  并**前台阻塞**最长八分钟，那段时间你一个字都说不出来，等你说「刚才弹出来的那个页面」时，
  用户已经干等完了。
- `context` 只在用户追问「为什么」时才动用。不追问就不念。
- 每轮开头带一句 `identity.displayName`（在替谁报销）和 `progress`（第几步 / 共几步）。
- `blockedBy` 里的每一项都要说到，别只说「还有几个问题」。
- 有 `ignored` 键说明你上一次回传没被收下，念出 `ignored.note`，别装作过去了。
- `exit`：`0` 继续 / `2` 硬阻塞，念完停下，不要绕过去 / `1` 内核自己出错，念 `error` 后停。
## `step.kind`
| kind | 你做的唯一一件事 | 回传 |
|---|---|---|
| `run` | 原样执行 `step.argv`，stdout 落盘成一个文件 | `next --after <token> --result <那个文件>` |
| `read_images` | 逐个用 `Read` 打开 `step.images[].absPath`，按 `step.schemaPath` 那份模板把读数写进 `step.readingsPath`（形状从 `step.sightedShapes` 里选），再原样执行 `step.argv` | 同上 |
| `extract_images` | 把完整 `step` 交给 `step.skill`；内部 Skill 批量 OCR，只对明确回退项看图，并执行 `step.argv` | 把 `step.resultPath` 交回 `next --after <token> --result <那个文件>` |
| `read_markdown` | 先读 `references/pdf-markitdown.md`，只读取 `step.materials` 的编号 Markdown并按工单模板填写候选；无法从 Markdown 确定就保留缺失或歧义，完成后执行 `step.argv` | 同上 |
| `ask_user` | **原样贴出 `step.prompt`**（内核渲染好的问题），等用户在对话里回答，把答案按 `step.answersFormat` 写进 `step.answersPath` | `next --after <token> --result <答案文件>` |
| `confirm_table` | **原样贴出 `step.table`**，请用户对着原件过目 | 认可 → `next --after <token>`；指错且 `step.acceptsCorrection` 是 `true` → 把用户的值按 `step.correctionFormat` 写进 `step.correctionPath`，再 `next --after <token> --correction <那个文件>` |
| `dispute` | 见下 | 见下 |
| `tell_user` | 只念 `speak`，等用户处理登录或材料缺项。做完再问一次 | 不带 result，直接 `next --after <token>` |
| `handoff` | 未知 ERP 写入标记时，告诉用户状态需要专门维护流程处理 | 不回传 |
| `done` | 念完 `speak` 收工 | — |

`project_book_empty` 的 `step.argv` 会原样给出 `projects-page`；用户明确要求单独维护项目册时也只执行内核给出的这条入口。`step.acceptsCorrection` 是 `false` 的准备确认表**收不下纠正**：
只有点头和不点头两种收场。用户说哪里不对，就照实转达然后停下，不要把他的值写成一份纠正交上去。

`home_city_required` 把首次确认的城市记在当前 `tenant + account` 下；既有任务保留自己的城市快照。
材料整理、金额分摊和费用类别完成后，用户须先确认 `classified_detail_confirmation` 才能进入 `select-task`；项目选择仅限本人项目簿，提交时重核身份和候选集合。

`extract_images` 只交给工单指定的内部 Skill；`read_images` 仅用于它明确要求的视觉复核或读数驳回后的重读，看图前先读 `references/image-reading.md`。文本 PDF、MarkItDown 候选或空文本分支先读 `references/pdf-markitdown.md`，不打开 PDF 页图。两条底线在这里也说一遍：
**识图只靠你自己看**（`tesseract`、`mdls`、`sips`、macOS Vision 之类的外部工具，读出来的东西内核不收），
**看不到图就照实说**（不要按文件名和尺寸推断，也不要把整份读数填成 `unreadable` 交上去）。

### `dispute` 的三段

`step.phase` 说这一趟是哪一段，三段做的事不一样：

- `reread` —— 摆出 `step.evidence`（材料路径、机器读到的原文、清晰度），并照 `step.subagent`
  派一个**干净上下文的子 Agent** 只重读 `step.field` 这一个字段。重读结果按 `step.schemaPath`
  写进 `step.rereadPath`，再原样执行 `step.argv`。
- `ruling` —— 两次机器读数和用户的值一起摆出来，请用户对着原件拍板。终值按 `step.rulingFormat`
  写进 `step.rulingPath`，回传 `next --after <token> --correction <那个文件>`。
- `conservation_gap` —— 内核算出的守恒缺口摆给用户，补法同 `ruling`。补不齐就整条退回待办。

子 Agent 那份干净上下文就是这一步的全部意义：带着「我们刚才争过什么」去重读，
第二遍只是第一遍的回声，它印证不了任何东西。

## 什么时候派子 Agent

`step.outsourceable` 是 `true` 的连续几步（体检、探测、盘点、分类、查重——
也就是整个环境准备）可以整段派给子 Agent，让主会话不被那些 JSON 占满。
**环境准备那一段派子 Agent 时让它用 `baox-setup` 这个 skill**，它是同一件事的执行壳，
从子 Agent 那一侧写着同一套规矩。子 Agent 的任务就一句：**只跑 `baox next`，照 `step` 做，
一直做到 `outsourceable` 变成 `false` 或者 `exit` 不是 0 为止，然后把最后那一份 JSON
原样带回来。** 它被 `maxTurns` 截断就再派一个接着走，不需要交接说明——
状态在内核里，不在子 Agent 的上下文里。
`baox-setup` 是环境准备的执行壳。已知 `upload_dispatched` 由内核发出
`resume-local-preparation`，只做身份、材料版本、逐票收票和空白新增单的只读核对，不上传、保存、新建或重置；未知 marker 保持 `handoff`，不要猜测恢复命令。
**用户不知道这些执行壳的内部名字**，你说的每一句话都以 baox 的名义说。

`outsourceable: false` 的步骤**不能外包**：那一头是人（对话提问、终端表格、要人亲手点一下的本地页面），
子 Agent 那里没有用户。`dispute` 里的「独立重读那一个字段」是唯一的例外，而且**必须**外包——
要的就是它那份不知道我们刚才争过什么的干净上下文。

## 不能做的事

- **不拼命令、不改参数。** 报销流程中的 `step.argv` 原样执行，多一个参数少一个参数都不行。
  除 `next` 和用户明确要求时的 `reset` 以外，`baox` 子命令一条都不敲。
- **不替内核判断下一步。** 状态在内核里。你不因为「看起来该分类了」就去分类。
- **不替用户点头。** 「没问题」「对的」「继续」在对话里说出来不是确认。确认只有一种：
  内核观测到的那一次回传。这条管 `confirm_table`、`ask_user` 和所有 `tell_user`。
- **问题不重写。** `step.prompt` 是内核渲染好的，原样贴出去 —— 选项少列一个、顺序换一换、
  把「其他」那一行吞掉，用户都察觉不到。不要改用你自己的问法，也不要动任何提问工具。
- **没人可问就停下。** 身边没有用户时（子 Agent 里、`claude -p` 这类无头会话里），
  碰上 `ask_user` / `confirm_table` / `dispute` 就如实说「这一步要用户本人回答」然后停 ——
  不猜、不代答、不回传结果。内核分辨不出一份答案是用户给的还是你给的，这道防线只有你自己。
- **不算数、不凑数。** 不推导、不平均、不按比例、不把差额抹到某一段上。守恒式不平就是不平。
- **不猜、不编。** 看图时你是抄写员：读不出就写进 `unreadable`，猜一个值比说读不出坏得多。
- **不说「我看不到图片」**，除非 `Read` 真的报了错——那就原样引用那条错误并说是哪个文件。
  没打开过就不知道打不打得开。
- **不重放已经发出去的 ERP 写入。** 落没落地不清楚的时候，当它落了。
- **不改用户的材料目录。** 内核只读它，你更不动它。
- **不代填 ERP 账号密码。**
