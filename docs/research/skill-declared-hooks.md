# Skill 声明的 PreToolUse 钩子，在项目域到底生不生效

> **状态：归档（2026-09-11）。** [本地报销应用](../design/standalone-app.md)去掉了 Agent，Claude Code Skill 钩子的行为不再影响产品。本文仍是 [ADR-0010](../adr/0010-kernel-side-command-guard.md) 守卫的实测依据，`50931a3:kernel/src/guard.mjs` 与 `50931a3:kernel/test/skills.test.mjs` 引用它；随守卫一起删除。

**结论：不生效。** SKILL.md 的 frontmatter 里声明的 `hooks.PreToolUse` 一次都不会被调起。
同一个脚本挂到 `.claude/settings.json` 上则确实拦得住，而且连 `bypassPermissions` 都压不过它。

这一条是 1.0.0 施工单里「合并前必须拿到的结论（真机）」那一项。在此之前的把握
来自实现与文档的旁证，不是实测；实测的结果和旁证相反，所以走了施工单预备的退路。

## 环境

- Claude Code **2.1.263**，macOS 26.6.2，Node v26.4.0
- 项目域：`<项目>/.claude/skills/<name>/`
- `claude -p --permission-mode bypassPermissions`（非交互）

## 实验一：写在 SKILL.md frontmatter 里

```yaml
---
name: guardtest
description: Guard test skill.
allowed-tools: Bash
hooks:
  PreToolUse:
    - matcher: Bash
      hooks:
        - type: command
          command: node ${CLAUDE_SKILL_DIR}/hooks/guard.mjs
---
```

SKILL.md 正文让模型跑一条本该被拦下的命令。守卫脚本把每一次调用都追加进一个日志文件，
并对该命令 `exit 2`。

| 观测 | 结果 |
|---|---|
| 守卫被调起的次数 | **0** |
| 那条命令 | **照跑不误**（被拦的目标进程留下了自己的运行记录） |

守卫不是"拦了但没拦住"，是**根本没被调起**。frontmatter 里的 `hooks` 这个键被静默忽略了
—— 没有警告，没有报错。这正是最坏的一种失败：看起来配好了。

## 实验二（对照）：同一个脚本挂在 `.claude/settings.json`

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "node <abs>/guard.mjs" }] }
    ]
  }
}
```

SKILL.md 那一侧把 `hooks` 整段删掉，其余一字不改。

| 观测 | 结果 |
|---|---|
| 守卫被调起的次数 | 1 |
| 守卫看到的命令 | `node /tmp/.../fake-baox.mjs doctor` |
| 那条命令 | **没跑**（目标进程没有留下任何运行记录） |
| 模型看到的 | `PreToolUse:Bash hook error: ...: GUARD-DENY: ...` |

两个实验只差 `hooks` 写在哪里，所以守卫脚本本身、退出码约定、`bypassPermissions`
这几项都被这一组对照排除掉了。**`exit 2` + stderr 的拦截约定是好用的，
问题只在于 Skill 声明的那一份从来没有被读进去。**

## 顺带测出来的一件事：`CLAUDE_SKILL_DIR` 不在环境里

同一轮里让一个 skill-active 的 Bash 调用把自己的环境打出来：

```
SKILL_DIR_RAW=[<UNSET>]
```

**`CLAUDE_SKILL_DIR` 并不存在于 Bash 工具的环境变量里。** 三份 SKILL.md 里
`node "${CLAUDE_SKILL_DIR}/kernel/bin/baox.mjs"` 这个写法之所以看起来能跑，
是因为**模型自己把它换成了绝对路径**——不是 shell 展开的。真按字面执行，
它会展开成 `/kernel/bin/baox.mjs` 然后 ENOENT。

这件事的份量比它看起来大：这套设计的前提是「模型原样执行 `step.argv`，一个字都不改」，
而入口那一行恰恰只有靠模型**改**它才能跑起来。

实际稳定出现的是这几个（两次运行都在）：

```
AI_AGENT=claude-code_2-1-263_agent
CLAUDECODE=1
CLAUDE_CODE_ENTRYPOINT=sdk-cli
CLAUDE_CODE_SESSION_ID=…
CLAUDE_PID=…
```

所以内核守卫的判据取 `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` / `CLAUDE_SKILL_DIR` /
`AI_AGENT` 的并集，而不是施工单原定的 `CLAUDE_SKILL_DIR` 单项——单认它等于守卫永远不生效。

## 落到 1.0.0 的做法

1. **守卫做进内核自身**（`50931a3:kernel/src/guard.mjs`）。这是兜底的那一层，不依赖任何安装步骤。
2. **`50931a3:skills/baox/hooks/guard.mjs` 仍然保留**，但改挂 `.claude/settings.json`，作为可选的外层。
   判据从内核那一份 import，不在钩子里抄第二遍。
3. 放行的规矩是「`next`，外加内核**刚刚**放进 `step.argv` 的那一条」，
   不是「只有 `next`」——`kind: "run"` 那一步本来就要模型去跑低层命令。

## 复验

这两个实验都是几十行的一次性脚本，重跑的成本很低。Claude Code 升版之后
（尤其是 frontmatter 字段表有变动时）值得重跑实验一：如果哪天它开始生效，
外层可以从 settings.json 收回 SKILL.md，内核那一层不受影响，照样留着。
