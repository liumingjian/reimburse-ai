# 终端多选在无头会话里不存在

施工单 [implementation-plan.md](../design/implementation-plan.md) 的「真机待验」第 2 项：
**终端多选（`AskUserQuestion`）在非交互 / `--print` 模式下的行为，未见文档。**
本文是那一项的结论。

## 环境

| | |
|---|---|
| 机器 | 用户的 MacBook Pro（macOS，Apple Silicon） |
| Claude Code | 2.1.263 |
| Node | v26.4.0 |
| 日期 | 2026-09-07 |

## 怎么量的

不问模型"你有没有这个工具"（那是自述，不算证据），直接读 `--output-format stream-json`
第一条 `system/init` 事件里的 `tools` 数组 —— 那是这次会话真正挂上的工具清单。

```bash
claude -p "ok" --output-format stream-json --verbose --max-turns 1
```

## 结论

**`AskUserQuestion` 不在无头会话的工具清单里。** 两种无头形态都不在：

| 形态 | `AskUserQuestion` |
|---|---|
| `claude -p`（`--print`） | **不存在** |
| `claude -p --input-format stream-json`（流式输入，headless 里唯一能回话的形态） | **不存在** |

清单里有 `Task`/`Bash`/`Read`/`Write`/`WebSearch` 等等，唯独没有它。
工具本身是有的（`AskUserQuestion` 这个字符串就在 CLI 的可执行文件里），
是**无头会话不挂载它**。

因此契约里那三步在无头会话里根本执行不了：`ask_user`、`confirm_table`、
以及 `dispute` 的对话部分。原先只说"子 Agent 里不可用"，现在范围要扩大：
**任何没有人坐在终端前的会话都不可用。**

## 顺带量到的：环境变量分不出有头无头

守卫（[ADR-0010](../adr/0010-kernel-side-command-guard.md)）靠环境痕迹判"是不是模型在敲"。
那么内核能不能顺手判出"是不是无头"？**不能。**

| 场景 | Bash 工具看到的痕迹 |
|---|---|
| `claude -p`（本轮实测） | `CLAUDECODE=1`、`AI_AGENT=claude-code_2-1-263_agent`、`TERM=xterm-ghostty` |
| skill-active 的调用（[skill-declared-hooks](skill-declared-hooks.md) 那一轮） | 上面两个，外加 `CLAUDE_CODE_ENTRYPOINT=sdk-cli`、`CLAUDE_CODE_SESSION_ID`、`CLAUDE_PID` |

`CLAUDE_CODE_ENTRYPOINT` 在 `-p` 里干脆不出现，而它出现的那一轮（`sdk-cli`）**同样是无头的**。
所以它标的是"从哪个入口来的"，不是"有没有人在"。`TERM` 更靠不住：`-p` 跑在用户的
终端里，`TERM` 照样是 `xterm-ghostty`。

**没有一个环境变量能可靠地区分有头和无头。**

## 落到 1.0.0 的做法

施工单原本给的退路是"退回本地页面"。**不采纳**，理由是它解决不了真正的问题：
无头会话多半根本没有人在（`-p` 跑在脚本里、子 Agent 跑在别的上下文里），
弹一个没人点的页面只是把"卡住"换个地方发生，还多养一条只在异常路径上走的代码。

改为把这件事说死：

1. **无头运行不是 baox 支持的形态。** 需要人回答的三步只能在交互式会话里做，
   这条写进 [next-contract](../design/next-contract.md) 的「子 Agent 的可用范围」一节。
2. **没有终端多选就停下，不许代答。** 写进 `skills/baox/SKILL.md`：手上没有那个工具时，
   如实说"这一步要人回答，请在交互式会话里继续"，然后停 —— 不猜、不代填、不回传结果。
   这是这套设计里少数只能靠说明书约束的地方：内核收到一份答案时，无法分辨它出自
   用户之口还是模型之手（`ask_user` 的答案本来就没有内核观测得到的凭据），
   能挡住的只有硬校验那一关（守恒式、格式、段数），挡不住一个"正好也平"的编造。
   这条限制是真的，写在这里，不假装它是机制。
