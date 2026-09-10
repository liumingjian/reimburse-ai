# 人机交互

这份 reference 只在 `baox` 收到 `ask_user`、`confirm_table`、`tell_user` 或 `dispute` 时读取。
当前内核把凭据放在响应顶层的 `stepToken`，把当前动作和材料放在 `step`；`step.argv` 只表示内核发出的可执行命令。当前响应没有 `step.return` 或 `step.completion`，不要自行补出这两个字段。

| kind | 处理 | 回传 |
|---|---|---|
| `ask_user` | 原样贴出 `step.prompt`，等用户回答；按 `step.answersFormat` 把答案写到 `step.answersPath` | 使用当前响应的 `stepToken`，执行 `next --after <stepToken> --result <step.answersPath>` |
| `confirm_table` | 原样贴出 `step.table`，请用户对照原件确认；可纠正时按 `step.correctionFormat` 写到 `step.correctionPath` | 确认：`next --after <stepToken>`；纠正：加 `--correction <step.correctionPath>` |
| `tell_user` | 原样念 `speak`；若存在 `step.table`，也原样贴出表格；等用户完成其中要求 | `next --after <stepToken>` |
| `dispute` | 按 `step.phase` 处理：`reread` 只交给干净上下文子 Agent 读取 `step.field`；`ruling`/`conservation_gap` 等用户对原件给终值 | 重读按 `step.rereadPath` 写入并原样执行 `step.argv`，再交 `--result`；用户终值按对应格式写入后交 `--correction` |

提问和确认都在当前对话中完成，不调用 `AskUserQuestion` 等提问工具。没有用户在场时不代答、不确认、不写纠正文件。所有内核给出的 `step.argv` 原样执行；模型不自行选择低层命令。
