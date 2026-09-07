# 「模型不拼命令」的守卫做在内核里，不做在 Skill 声明的 hook 里

[ADR-0009](./0009-kernel-decides-next-step.md) 把"下一步做什么"搬进了内核，
但那之后模型**仍然**握着一台能任意执行 shell 的机器。说明书里写着"除 `next`
以外的子命令你一条都不敲"，那是一句劝告；这条 ADR 记的是它怎么变成机制。

**守卫做在内核自身**（`kernel/src/guard.mjs`）：除 `next` 以外的子命令，
在内核检测到自己是被 Agent 调起的时候一律拒绝执行，退出码 2，并把这次拒绝
记进 `<数据目录>/logs/refused.jsonl`。

放行的规矩是两条，不是一条：

1. `baox next`——模型自己敲得动的唯一一条。
2. 内核**刚刚**放进 `step.argv` 的那一条完整命令行，逐项全等匹配。

第二条是必须的：`step.kind: "run"` 那一步本来就是内核让模型去跑一条低层命令。
契约的原话是「拦下**不在 argv 里**的越权命令」，不是「拦下所有低层命令」。
白名单只有一条，且随下一次 `next` 当场作废。

## 为什么不是 Skill frontmatter 里的 hook

施工单原定的做法是在 `skills/baox/SKILL.md` 的 frontmatter 里声明 `hooks.PreToolUse`。
合并前做了真机实测，**结论和预期相反**：

| | Skill frontmatter | `.claude/settings.json` |
|---|---|---|
| 守卫被调起 | **0 次** | 1 次 |
| 被拦的命令 | **照跑不误** | 没跑 |

frontmatter 里的 `hooks` 键被静默忽略——没有警告，没有报错。这是最坏的一种失败：
看起来配好了。完整的实验记录见 [skill-declared-hooks.md](../research/skill-declared-hooks.md)。

## Considered Options

- **就这么发，把"模型不拼命令"留成说明书里的一句话。** 那句话正是这次重构的全部意义，
  留成劝告等于这一批改动只完成了一半。
- **靠 `.claude/settings.json` 的 hook 作为唯一的守卫。** 它确实拦得住，
  而且连 `bypassPermissions` 都压不过它。但它需要用户在自己的项目配置里手工加一段
  ——一个会被忘记、会被覆盖、baox 自己观测不到的安装步骤。守卫不能依赖安装步骤：
  没装上的时候它不报错，只是不生效。
- **判据用 `CLAUDE_SKILL_DIR`**（施工单原文）。同一轮实测里这个变量**根本不在**
  Bash 工具的环境里，单认它等于守卫永远不生效。改取
  `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` / `CLAUDE_SKILL_DIR` / `AI_AGENT` 的并集。
- **把低层命令整个删掉。** 那样人也没法排障了。真机上排障靠的就是手敲那二十来条命令
  看中间产物；删掉它们等于把唯一的诊断手段一起删了。

## Consequences

- **人手敲不受影响**，前提是他在一个真终端里——没有那几个环境痕迹就一律放行。
  人在 Claude Code 里手敲时，环境痕迹和模型敲的一模一样，需要在末尾加 `--i-am-a-human`。
- `--i-am-a-human` **不是密码，也不打算是**。模型当然"能"加上它。它挡的是模型顺着
  说明书或自己的判断去拼一条低层命令，不是一个立意越狱的模型——后者在一台能任意执行
  shell 的机器上本来就挡不住。它真正的意义是：加上它是一次留痕的、明知故犯的动作。
- **`refused.jsonl` 是验收判据本身。**「全程模型只出现过 `baox next`」不靠回看对话确认，
  靠这个文件为空确认。所以它只在拒绝时写；放行不记，否则"为空"就不再是个信号。
- `skills/baox/hooks/guard.mjs` 仍然保留，作为**可选的外层**，挂在 `.claude/settings.json`
  上（怎么挂见 INSTALL.md）。它的判据从内核那一份 import，不在钩子里抄第二遍。
  装了它，命令连进程都不会起；没装，内核那一层照样拦得住。
- Claude Code 哪天让 frontmatter 的 `hooks` 生效了，外层可以收回 SKILL.md，
  内核这一层不受影响，照样留着。
