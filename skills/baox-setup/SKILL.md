---
name: baox-setup
description: baox 环境准备的执行壳。Invoked by the model only, from a baox sub-agent, to run the environment-preparation stretch of `baox next` (Node/Chrome/login/identity binding). Never surfaced to the user — they only know `baox`.
user-invocable: false
disable-model-invocation: false
allowed-tools: Bash
---

# baox-setup

用户看到的一切都是中文。English is for this file only.

**用户不知道有这个 skill，也不需要知道。** 它是 `baox` 主会话派子 Agent 跑环境准备时用的执行壳。
用户的入口只有 `baox` 一个。

## 你只会敲一条命令

```bash
node "${CLAUDE_SKILL_DIR}/kernel/bin/baox.mjs" next --dir "<材料目录>"
```

回传用 `next --after <stepToken> [--result <文件>]`。要跑什么由内核放在 `step.argv` 里，
你原样执行。Node 装没装、Chrome 起没起、有没有登录、这台机器绑的是谁——判断全在内核，
你一个都不做。

## 怎么念内核的话

- **`speak` 原样念**，一个字不改。`context` 只在用户追问时才动用。
- **先念 `speak`，再执行 `step.argv`。** 认身份那条命令会弹出一个本地页面并**前台阻塞**
  最长八分钟，那段时间你说不出话——事后再说「刚才那个页面」，用户已经干等完了。
- `exit`：`0` 继续 / `2` 硬阻塞（念完停下，没有「确认一下继续」这回事）/ `1` 念 `error` 后停。
- 有 `ignored` 键就念 `ignored.note`：你上一次回传没被收下。
- 跑完这一段把最后一份 `next` 的 JSON **原样**带回给派你来的会话，不要改写、不要总结成结论。

## 三种 `step.kind` 会落到你身上

| kind | 你做的唯一一件事 | 回传 |
|---|---|---|
| `run` | 原样执行 `step.argv`，stdout 落盘 | `next --after <token> --result <那个文件>` |
| `tell_user` | 念 `speak`，等用户自己动手（多半是登录）。**这一步做不了**——你这里没有用户 | 停下，把 JSON 带回主会话 |
| `confirm_table` / `ask_user` / `dispute` | 同上，都要人。`step.outsourceable` 是 `false` | 停下，带回主会话 |

**`step.outsourceable` 变成 `false` 的那一刻就是你这一趟的终点。** 那一步的另一头是人，
而你这里没有人。硬撑着往下走只会挂在一个永远不会发生的点击上。

## 环境准备走到哪算完

内核说了算：`next` 报出的 `progress.phase` 离开「环境准备」，或者 `state` 变成材料那一段的状态。
你不自己判断「应该差不多好了」——`doctor.ready`、`probe.status` 这些字段是内核的判据，不是你的。

## 不能做的事

- **不拼命令、不改参数。** 除 `next` 以外的 `baox` 子命令一条都不敲。
- **不装东西。** Node 缺了是内核让用户去装，不是你 `brew install`。装什么、装不装，用户说了算。
- **不代填 ERP 账号密码。** 登录整件事是用户的，账号和密码不经过你。
- **不替用户认身份。** 绑定只在那个本地确认页上的一次点击里产生，页面上的每一个值都来自
  内核自己从 ERP 读到的东西。你不往那里输入任何字符串，也不在对话里问用户「你叫什么」。
- **不替用户点头。** 「已登录」「已授权」在对话里说出来不是事实，是请你再去读一次。
- **不把这个 skill 报给用户。** 用户听到的一切都以 `baox` 的名义说出来。
