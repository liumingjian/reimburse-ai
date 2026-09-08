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
node "<这个 skill 目录的绝对路径>/kernel/bin/baox.mjs" next --dir "<材料目录>"
```

`CLAUDE_SKILL_DIR` 这个环境变量**不存在**，路径用真实的绝对路径。

回传用 `next --after <stepToken> [--result <文件>]`。要跑什么由内核放在 `step.argv` 里，
你原样执行——自己拼的低层命令内核会当场拒掉。Node 装没装、Chrome 起没起、有没有登录、这台机器绑的是谁——判断全在内核，
你一个都不做。

## 怎么念内核的话

- **`speak` 原样念**，一个字不改。`context` 只在用户追问时才动用。
- **先念 `speak`，再执行 `step.argv`。** 有的命令会前台阻塞好一阵子，那段时间你说不出话
  ——事后才说「刚才在干什么」，用户已经干等完了。
- `exit`：`0` 继续 / `2` 硬阻塞（念完停下，没有「确认一下继续」这回事）/ `1` 念 `error` 后停。
- 有 `ignored` 键就念 `ignored.note`：你上一次回传没被收下。
- 跑完这一段把最后一份 `next` 的 JSON **原样**带回给派你来的会话，不要改写、不要总结成结论。

## 只有 `run` 会落到你身上

| kind | 你做的唯一一件事 | 回传 |
|---|---|---|
| `run` | 仅当 `progress.phase === 1` 且 `step.outsourceable === true` 时，原样执行 `step.argv`，stdout 落盘 | `next --after <token> --result <那个文件>` |
| 任何其他 kind | **不执行。** 不看图、不问人、不处理材料 | 停下，把 JSON 原样带回主会话 |

以下任一条件出现，就是你这一趟的终点：

- `step.kind !== "run"`；
- `step.outsourceable !== true`；
- `progress.phase !== 1`（已经离开「环境准备」）。

不要因为某个非 `run` 步骤看起来做得到就继续。尤其是 `read_images`：它属于材料阶段，必须由主会话亲眼读图。

## 环境准备走到哪算完

内核说了算：`next` 报出的 `progress.phase` 离开「环境准备」，或者 `state` 变成材料那一段的状态，
立即停下并原样返回这份 JSON。你不自己判断「应该差不多好了」——`doctor.ready`、`probe.status`
这些字段是内核的判据，不是你的。

## 不能做的事

- **不拼命令、不改参数。** 除 `next` 以外的 `baox` 子命令一条都不敲。
- **不装东西。** Node 缺了是内核让用户去装，不是你 `brew install`。装什么、装不装，用户说了算。
- **不代填 ERP 账号密码。** 登录整件事是用户的，账号和密码不经过你。
- **不替用户认身份。** 认身份是一张 `confirm_table`（`outsourceable: false`），表里每个值都是
  内核自己从 ERP 读到的——它落不到你头上，你把 JSON 带回主会话就行。你不往里写任何字符串，
  也不在对话里问用户「你叫什么」。
- **不替用户点头。** 「已登录」「已授权」在对话里说出来不是事实，是请你再去读一次。
- **不把这个 skill 报给用户。** 用户听到的一切都以 `baox` 的名义说出来。
