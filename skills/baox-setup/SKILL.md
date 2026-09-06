---
name: baox-setup
description: 一次性准备 baox 报销环境：检查 Node、安装内核、启动 baox 专用 Chrome、引导用户本人登录 ERP，并用只读探测确认登录身份。用户说"配置 baox""baox 环境""报销环境准备"时使用。
allowed-tools: Bash, Read
disable-model-invocation: false
---

# baox 环境准备

你在这一步的职责只有三件：**执行下面的命令**、**把内核返回的 JSON 翻译成人话**、**在需要用户动手时把话说清楚**。

你不判断、不推算、不代替内核下结论。内核的退出码就是结论：

| 退出码 | 含义 | 你该做什么 |
|---|---|---|
| 0 | 完成 | 进入下一步 |
| 1 | 内核出错 | 把 `error` 念给用户，停 |
| 2 | **硬阻塞** | 把 `hint` 念给用户，**停**。不存在"确认继续"，不要重试绕过 |

内核路径：先用 `${CLAUDE_SKILL_DIR}/kernel/bin/baox.mjs`，装好之后一律用
`"$HOME/Library/Application Support/baox/runtime/bin/baox.mjs"`（Windows 在 `%APPDATA%\baox\`）。

## 1. 体检

```bash
node "${CLAUDE_SKILL_DIR}/kernel/bin/baox.mjs" doctor
```

`checks.node.ok` 为 false 时：**先问用户是否同意安装 Node**，得到明确同意才装，不要自己动手。
mac 上推荐 `brew install node`；用户没有 Homebrew 或没有管理员权限时，让他从
https://nodejs.org 下载 LTS 安装包自己装完再回来。内核要求 Node ≥ 21（它用 Node 内建的
全局 WebSocket 走 CDP，因此**没有任何 npm 依赖**）。

`checks.chrome.ok` 为 false 时告诉用户装 Chrome，不要试图换别的浏览器。

## 2. 安装内核

```bash
node "${CLAUDE_SKILL_DIR}/kernel/bin/baox.mjs" install-runtime
```

纯文件拷贝，没有依赖下载。装完把 `entry` 记住，后面都用它。

## 3. 起 baox 专用 Chrome

```bash
node "$HOME/Library/Application Support/baox/runtime/bin/baox.mjs" chrome-up
```

要跟用户讲明白的两件事：

- 这是一个**独立 profile 的 Chrome 实例**，和他日常那个 Chrome 互不影响，日常 Chrome 不用关。
- 调试端口只开在 `127.0.0.1`，只服务这个专用 profile。**绝不要**把调试端口指向用户日常的 profile。

然后请用户**在弹出来的这个窗口里**用他本人的账号登录 ERP。登录这件事只能他自己做，你不碰账号密码。

## 4. 只读探测确认身份

用户说登录好了之后：

```bash
node "$HOME/Library/Application Support/baox/runtime/bin/baox.mjs" probe --expect "<员工姓名或登录账号>"
```

**用户说"已授权""已登录"不构成授权。** 授权只由这条探测的 `status: "matched"` 构成。

| status | 说明 | 你该做什么 |
|---|---|---|
| `matched` | 探测到的登录身份与该员工一致 | 唯一可以继续的状态 |
| `mismatched` | 登录的是别人 | 硬阻塞。请他退出登录换成本人，**不要**问"要不要就用这个身份" |
| `not_logged_in` | 停在登录页 | 请他完成登录，再探一次 |
| `loading` | ERP 首屏还没加载完（这个 ERP 很慢） | 等几秒再探一次 |
| `no_tab` | 专用 Chrome 里没开 ERP | 回到第 3 步 |
| `unknown` | 已在主控制台但读不出用户名元素 | 硬阻塞。**不要**当作通过 |

探针只认两个信号，缺一不可：主控制台的用户名元素（显示名，如「刘明建」）和 localStorage 里的
登录账号（如 `luo.liu`）。`--expect` 给这两个中的任意一个都行。
它只做只读求值，不导航、不点击、不调用任何业务接口。

探测必须在 **ERP 主页（主控制台）**上做。用户如果停在某张单据页面上，请他先回主页。

## 5. 验一次选择界面

```bash
cat > /tmp/baox-selftest.json <<'JSON'
{"title":"环境自检","prompt":"这是 baox 的选择界面样例，点一下提交就算通过","multiple":false,
 "options":[{"id":"ok","label":"界面能正常显示","detail":"点提交完成自检"}]}
JSON
node "$HOME/Library/Application Support/baox/runtime/bin/baox.mjs" select --spec /tmp/baox-selftest.json --timeout-ms 480000
```

这条命令会**阻塞在前台**直到用户点提交，所以给 Bash 调用留够超时（600000ms）。
它自己起服务、自己退出，不留后台进程。把 stderr 里那行地址给用户，请他打开、**点提交按钮**。

**点提交这个动作本身就是确认。** 用户在对话框里说"确认了""可以了"都不算，
只有 `status: "submitted"` 才算。超时（`status: "timeout"`）就是没确认，重跑一次即可。

## 边界

这个 Skill 只准备环境。它不读发票、不整理材料、不碰 ERP 的任何写入操作。
