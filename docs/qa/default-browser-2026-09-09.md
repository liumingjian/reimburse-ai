# 默认浏览器修复 QA

## 用户发现的问题

安装 `1.1.0-qa.1` 后，第一次使用就停在环境准备，要求配置 `BAOX_EGO_TASK_SPACE`。用户明确：正式 Skill 在系统默认浏览器中打开页面；ego 仅用于 Agent 自动化 QA。

## 复现

在开发工作树中清除 `BAOX_EGO_TASK_SPACE` 后调用 `probeIdentity({waitMs: 0})`，实际返回 `EGO_TASK_SPACE_REQUIRED`。原因是正式身份探测和本地页面直接依赖 ego；不是用户少装了正式依赖。

## 验收要求

- 默认模式调用系统 URL 打开方式，不指定 Chrome，也不凭残留 ego task space 配置选择测试浏览器。
- 本地页提交成功后可结束，不要求关闭一个未受控制的系统浏览器标签。
- ERP 身份与项目核验继续采用实际只读结果；权限不足、能力不支持和未登录分别报告。
- 仅显式 `BAOX_BROWSER=ego` 才进入 ego QA 路径。
- 完成回归后重新安装同版三个 Skill，备份旧候选；本轮不填写 ERP。

## 当前结果

修复候选 `1.1.0-qa.2` 已安装到 `/Users/lmj/repos/reimburse-ai/.claude/skills` 的三份 Skill；`.agents/skills` 发现链接保持有效。三份安装目录与 dist 递归哈希一致，入口语法检查通过；安装后 `doctor` 实跑返回 `browserMode: system`，当前为 `no_tab`，不要求 ego。旧 qa.1 备份在 `/Users/lmj/.baox-skill-backups/20260909-default-browser-qa1`。

- 真实系统打开验证：临时 loopback 页面通过 `open URL` 派发，没有指定浏览器；随后只读枚举找到唯一精确目标标签。临时服务器已关闭，用户标签未被关闭。
- 真实 `next --dir resources/real-env` 验证：使用隔离 `BAOX_HOME` 并清除浏览器 QA 环境变量，返回 `browser-open --url http://erp.antute.com.cn/k3cloud/html5/index.aspx`，不再返回 ego 配置要求；没有创建真实任务或执行 ERP 写入。
- 全套回归 536 项通过，包含默认浏览器多 ERP 标签歧义和缺失账号字段的保护。多页时要求保留唯一目标 ERP 页，不读取并选择第一个标签。
- 当前自动读取适配范围为 macOS Chrome/Edge Chromium；本机实际验证的是 Chrome，Edge 不记为真机 QA 通过，Safari 不属于 V1 支持范围。

真实系统检查：默认 HTTPS 浏览器为 `com.google.Chrome`，浏览器正在运行，窗口枚举可用。执行仅返回 `1 + 1` 的能力探针时，Chrome 返回错误 12：`Executing JavaScript through AppleScript is turned off`，并指明 `View > Developer > Allow JavaScript from Apple Events`。已向用户说明并等待其自行开启；没有修改浏览器设置。这是读取权限缺失，不是 ERP 登录状态证据。

剩余真实 QA：开启权限并登录后，验证 ERP 当前身份、异步项目读取和完整材料准备交互。身份仍沿用既有主控制台用户名 + 本地登录信息联合探测；真实切换账号后的会话一致性需要 QA，不能把单元测试记成真实身份验证。

数据核对边界：复查时旧记录路径 `~/.baox/tasks/2026-09-08-b34804ed20` 已不存在，因此本轮不能重新证明该任务的历史摘要未变；本轮回归使用隔离目录，未恢复或修改该旧任务。
