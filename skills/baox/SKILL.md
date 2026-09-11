---
name: baox
description: "报销。Use when the user wants to start, continue, or ask about a reimbursement from a folder of invoices and itineraries. This is the only baox entry point a user ever needs — environment setup and write recovery are dispatched from here."
allowed-tools: Bash, Read, Task, Skill
---

# baox

用户看到的一切都是中文。浏览器初始化、登录、读取失败或自动化 QA 时先读 `references/browser.md`；V1 只支持 Chromium 浏览器，普通交互和前置只读沿用用户的系统默认 Chrome/Edge 页面；确认后的 ERP 草稿写入与写入恢复由内核在需要时准备可接管的 Chromium 页面，Chrome 与 Edge 共用同一 CDP 适配器；ego 只用于显式自动化 QA。
当前流程以 ERP 草稿保存和严格回读为终点；准备确认后由内核自动完成导入、明细填写和保存。涉及材料包生成、充分性检查、准备确认或准备完成时，先读 `references/preparation.md`。
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

首次没有常驻城市时，内核会先通过位置 Adapter 获取一个城市级网络位置候选；获取成功后展示候选并请用户确认，获取失败才回退到直接填写。若执行环境已经提供了更可信的城市参考，首次命令可加 `--home-city-suggestion "<城市>"` 覆盖网络候选。`CLAUDE_SKILL_DIR` 环境变量**不存在**；路径使用这份 SKILL.md 所在目录的真实绝对路径。
第一次问要带 `--dir`；此后回传用 `--after <stepToken>`，**内核会把完整命令行放在
`step.argv` 里，你原样执行**。底层还有二十来条子命令，那些是给人手敲排障的，不是给你选的：
**内核会当场拒掉**（退出码 2，`status: "refused"`），并把这次拒绝记进日志。
撞上它不要换个写法再试，照实告诉用户你刚才想干什么。
## 怎么念固定话术

- **`speak` 原样念给用户**，一个字不改、不概括、不补充。措辞是内核写死的。
- **先念 `speak`，再执行 `step.argv`。** 顺序反过来会真的伤到人：有的命令会弹出一个本地页面
  并**前台阻塞**最长八分钟，那段时间你一个字都说不出来，等你说「刚才弹出来的那个页面」时，
  用户已经干等完了。
- `context` 只在用户追问「为什么」时才动用；只说业务原因，不念路径、组件、内部状态或错误代码。
- 每轮开头带一句 `identity.displayName`（在替谁报销）和 `progress`（第几步 / 共几步）；`interaction.templateId/version/status` 只供系统记录，不展示给用户。
- `blockedBy` 里的每一项都要说到，别只说「还有几个问题」。
- 有 `ignored` 键说明你上一次回传没被收下，念出 `ignored.note`，别装作过去了。
- `exit`：`0` 继续 / `2` 硬阻塞，念完停下，不要绕过去 / `1` 内核自己出错，念 `error` 后停。
## `step.kind`
| kind | 你做的唯一一件事 | 回传 |
|---|---|---|
| `run` | 原样执行 `step.argv`，stdout 落盘成一个文件；若打开报销专用浏览器，执行后等待用户在该窗口登录 | `next --after <token> --result <那个文件>` |
| `read_images` | 默认图片 Adapter。逐个用 `Read` 打开 `step.images[].absPath`，按 `step.schemaPath` 那份模板把读数写进 `step.readingsPath`（形状从 `step.sightedShapes` 里选），再原样执行 `step.argv` | 同上 |
| `extract_images` | 把完整 `step` 交给 `step.skill`；内部 Skill 先批量 OCR，候选不足的材料再用模型视觉兜底，并执行 `step.argv` | 把 `step.resultPath` 交回 `next --after <token> --result <那个文件>` |
| `read_markdown` | 先读 `references/pdf-markitdown.md`，只读取 `step.materials` 的编号 Markdown并按工单模板填写候选；无法从 Markdown 确定就保留缺失或歧义，完成后执行 `step.argv` | 同上 |
| `ask_user` | **原样贴出 `step.prompt`**（内核渲染好的问题），等用户在对话里回答，把答案按 `step.answersFormat` 写进 `step.answersPath` | `next --after <token> --result <答案文件>` |
| `confirm_table` | **原样贴出 `step.table`**，请用户对着原件过目 | 认可 → `next --after <token>`；指错且 `step.acceptsCorrection` 是 `true` → 把用户的值按 `step.correctionFormat` 写进 `step.correctionPath`，再 `next --after <token> --correction <那个文件>` |
| `dispute` | 见下 | 见下 |
| `tell_user` | 只念 `speak`，等用户处理登录或材料缺项。做完再问一次 | 不带 result，直接 `next --after <token>` |
| `handoff` | 未知 ERP 写入标记时，告诉用户状态需要专门维护流程处理 | 不回传 |
| `done` | 念完 `speak` 收工 | — |

`project_book_empty` 的 `step.argv` 会原样给出 `projects-page`；用户明确要求单独维护项目册时也只执行内核给出的这条入口。项目维护页只录入项目号，ERP 核验成功后名称由系统回填；用户提交后命令会直接返回，不需要再在对话中回复“完成”。`step.acceptsCorrection` 是 `false` 的准备确认表**收不下纠正**：
只有点头和不点头两种收场。用户说哪里不对，就照实转达然后停下，不要把他的值写成一份纠正交上去。

首次使用遇到 `home_city_required` 时，若系统给出网络位置候选，正确就回复「确认」，不正确就直接填写自己的城市，不再二次确认；没有候选时才直接填写常驻城市。已有记忆的新报销先展示「报销人、常驻城市」；回复「确认」继续，直接输入城市就覆盖默认值。既有任务保留自己的城市快照。
材料整理、金额分摊和费用类别完成后直接进入项目选择；项目选择仅限本人项目簿，提交时重核身份和候选集合。材料识别不会在中途要求用户确认，只有报销材料准备完成后展示一次覆盖所有 ERP 明细必填字段的最终表格。

图片识别默认使用 `vision-direct`：模型视觉读取后，候选直接进入分类和费用事件；也可以由协调器明确选择
`ocr-assisted`，先运行受管 OCR，缺字段或候选校验失败的图片再交给模型视觉。两条路径都不在单张材料完成后
打断用户。发票业务上只保留不含税金额、税额和价税合计；发票号码仅作为隐藏技术身份用于去重，开票日期和开票方不进入最终明细表。
`extract_images` 只交给工单指定的内部 Skill；`read_images` 用于默认视觉读取、视觉兜底或读数驳回后的重读，看图前先读 `references/image-reading.md`。文本 PDF、MarkItDown 候选或空文本分支先读 `references/pdf-markitdown.md`，不打开 PDF 页图。两条底线在这里也说一遍：
`read_images` 只靠你自己看图（`tesseract`、`mdls`、`sips`、macOS Vision 之类的外部工具，读出来的东西内核不收）；
`extract_images` 的 OCR 只能使用其受管运行时，缺口再由模型视觉补读。无论哪条路径，**看不到图就照实说**（不要按文件名和尺寸推断，也不要把整份读数填成 `unreadable` 交上去）。

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
- **不重放 ERP 写入、不改用户材料目录、不代填 ERP 账号密码。** 确认后的草稿写入由内核自动执行；落没落地不清楚时，当它落了，交给恢复流程只读核对。
- **不自造话术；确认只有「确认」；自动保存只保存报销草稿。** 普通员工只看到固定模板；保存不确定时先到报销系统核对，不重复操作。
