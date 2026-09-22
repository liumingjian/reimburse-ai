# 原生运维命令行

`@baox/operator` 是维护人员在本机运行的 SSH 命令行。它不推送或合并 Git 状态。只有显式确认的 native bootstrap
(原生依赖引导)、`prepare` 候选准备、恢复快照和 `deploy` 可以写入固定内网主机 `10.250.0.222`。它不支持多主机配置。

## 命令

在仓库根目录执行：

```bash
pnpm --filter @baox/operator operator plan
pnpm --filter @baox/operator operator status
pnpm --filter @baox/operator operator doctor
pnpm --filter @baox/operator operator logs --lines 200
pnpm --filter @baox/operator operator deploy --dry-run
pnpm --filter @baox/operator operator deploy [Git 引用] [--retain N]
pnpm --filter @baox/operator operator deploy --candidate <候选标识> [--retain N]
pnpm --filter @baox/operator operator prepare [Git 引用] [--relay /本地/source.tar]
pnpm --filter @baox/operator operator snapshot <候选标识> [--retain N]
pnpm --filter @baox/operator operator bootstrap-preview --proxy http://192.168.2.201:7890
pnpm --filter @baox/operator operator bootstrap-apply --confirm <确认摘要> --proxy http://192.168.2.201:7890
```

`plan [Git 引用]` 默认把 `origin/main` 解析为完整提交 SHA。它用该提交生成 Git 归档的 SHA-256，并列出工作树中没有进入归档的改动。显式引用也必须解析为已提交对象。命令不从工作树打包，因此本地未提交内容不会成为发布输入。

`status` 读取当前发布、两个 systemd 服务、数据目录和 maintenance gate (维护闸门) 状态。`doctor` 再读取
Node、隔离 GCC、构建 Python、pnpm、Caddy、`baox` 服务账号、受控构建环境和闸门包装器，并在发现不能安全
进行常规发布的条件时返回非零状态。`logs` 只读取 `baox.service` 与 `baox-caddy.service` 的 journal；`--lines`
必须在 1 到 1000 之间。

`deploy --dry-run [Git 引用]` 只做提交归档、原生运行时和维护闸门兼容性预检。它不会在主机上写入任何内容。
缺少隔离 GCC、构建 Python、服务账号或受控环境时，它只报告拒绝，不会安装、升级或替换任何前置依赖。当前主机
没有维护闸门时，命令拒绝常规发布，并说明首次启用必须是单独、明确、受控的维护变更。它不会执行“检查后停止服务”的路径。

`bootstrap-preview` 与 `bootstrap-apply` 的完整步骤、工件证明和中继规则见
[原生依赖引导](native-bootstrap.zh-CN.md)。只有 `bootstrap-apply --confirm <预览摘要>` 可以写入原生依赖；
它会重新解析 dnf 事务并拒绝受保护的系统运行时变更。

`prepare` 在读取 Git 归档或写入目标之前先检查维护闸门。它只接受已提交的 Git 引用；默认输入是本机由该提交生成的 tar 归档。`--relay` 只能提供与该本机归档 SHA-256 相同的文件，目标主机接收后会再次计算同一 SHA-256。该校验确认的是提交归档，不把归档校验和当作第三方构建资产的签名。

目标主机先取得共享的 `/opt/tools/baox/maintenance/deployment.lock`，再写入 `/opt/tools/baox/maintenance/deployment-journal.json`。锁所有者包含随机代次、进程号和进程起始身份；失联的旧进程不能删除新所有者的锁。准备过程在 `/opt/tools/baox/candidates/<提交前缀>-<归档前缀>/` 解包、构建并校验输出。SSH 中断后，后续同一候选会读取 journal：已经完整校验的归档可以继续构建；构建开始后中断则保留候选并返回恢复要求，不会自动重复不确定的构建。

成功的清单记录提交 SHA、归档 SHA、目标重新校验的 SHA、运行时版本、构建环境文件的 SHA 与键名，以及当前发布、Node 运行时引用和 Caddy/systemd 配置的恢复副本与哈希。环境变量值、令牌和其他机密不会写进清单、归档、日志或 journal。准备不会改动 `current`、共享运行时引用、服务、反向代理或数据目录，也不开放访问或切换版本。

`deploy [Git 引用]` 默认使用 `origin/main` 的已提交归档，先执行同一归档的候选准备，再在一个共享锁和维护窗口中创建新的、已演练的恢复快照并切换候选。`deploy --candidate <候选标识>` 只切换已准备的候选。两种形式都会先检查运行时和开放的维护闸门；只有与同一候选匹配的中断 journal 才能绕过这项新发布预检，以便在服务停止、闸门关闭时进行受限恢复。

切换先保留原发布、完整数据目录、Node 运行时引用和三份配置的私有恢复副本，再关闭准入、停止公网代理和原服务。候选发布先验证配置、启动服务、验证 loopback，并在维护闸门仍关闭时通过仅绑定 loopback 的临时 Caddy 实例验证代理的 `/api/session` 响应；它不会启动公网 Caddy。只有这些检查完成后才持久记录开放访问意图并重新开放闸门。开放访问意图之前的失败会恢复原发布、数据、运行时、配置及原始所有者和模式；恢复无法验证时保持屏障关闭。开放访问意图之后，即使 SSH 或闸门响应丢失，命令也不会自动覆盖数据或回滚发布，只报告需要运维人员核对的交接状态。

`snapshot <候选标识> [--retain N]` 只在维护闸门已验证为开放、没有屏障且写入状态可知时开始。目标先持久记录准入意图，再关闭准入、排空写入、停止 Caddy 和原服务。它把完整数据目录（包括 SQLite 已提交 WAL 与原始文件）以及原发布、运行时和配置恢复信息写入 `/opt/tools/baox/recovery-snapshots/` 的私有目录；数据文件和目录的原始所有者与模式保存在私有恢复元数据中。随后它在独立的数据、端口、令牌和 socket 路径上启动原可执行文件，校验 SQLite 并验证隔离闸门重新开放、关闭和重新开放。只有原服务和公网探测均通过后才重新开放生产闸门；此命令不会切换版本。

`--retain` 默认是 3，范围为 1 到 20。每个已验证快照与它拍摄时的原发布关联：在 A 切换到 B 前创建的快照恢复 A，不声称恢复 B。清理只处理固定发布目录中有匹配恢复记录和匹配已验证快照的发布对；即使保留数为 1，也保留当前发布和最近一个不同的可恢复发布对。容量预检在关闭准入之前完成，清理只会在新快照已验证后进行。

候选准备只报告缺失的 Node、隔离 GCC、构建 Python、pnpm、Caddy、服务账号和受限构建环境，不会安装或修复它们。bootstrap（初始化）是单独的显式操作。`status` 只读取协调状态和 journal；即使发现异常锁或 journal，也不会改写它们。

## 固定主机约定

生产构造固定使用 `root@10.250.0.222`、`/opt/tools/baox` 和 `/opt/tools/baox/data`。命令行没有主机、SSH 用户、数据目录、socket 或令牌选项。测试只能通过 TypeScript 注入受控 `HostTransport`，或向 `SshHostTransport` 注入 runner 与 profile，不能借此改变生产命令的目标。

维护闸门使用 `${BAOX_DATA_DIR}/maintenance-gate.sock`，当前路径是 `/opt/tools/baox/data/maintenance-gate.sock`。SSH 驱动调用主机上的 `/opt/tools/baox/bin/baox-maintenance-gate status`。该包装器从主机本地的受限文件读取令牌，只输出协议 JSON。令牌不能出现在命令参数、计划、日志、归档或诊断输出中。

`status` 可以报告缺失闸门；`doctor` 和 `deploy --dry-run` 将缺失、不可用、协议不兼容或未知写入状态都当作拒绝。后续的 bootstrap、候选准备、恢复快照和切换命令必须沿用这个边界。

## 输出和凭据

所有命令都支持 `--json`。日志和错误输出会遮盖 password、token、secret、credential、cookie 和 authorization 值，以及中文的“临时密码”与“密码”值。这个版本不创建本地凭据文件。后续若必须保留临时管理员凭据，文件必须由创建者用 `0600` 模式写入，且不得进入归档、日志、计划、清单或 journal。

## 已初始化主机的发布

2026-09-22 已在 `10.250.0.222` 完成原生依赖初始化、首次维护闸门接入，以及提交 `8340387` 的正式发布。
初始化复用了 uv 管理的 Python 3.12.14 和构建虚拟环境；系统 Python 仅供系统 DNF 查询使用。
Kylin 上的 SQLite 原生模块已通过隔离 GCC 编译，恢复快照通过原服务的独立恢复演练。发布后的
`doctor` 返回健康，访问入口为 <http://10.250.0.222>。

PR #269 合并前，在包含此运维工具的分支中执行：

```bash
pnpm --filter @baox/operator operator deploy codex/implement-spec-262
```

合并并更新本地 `origin/main` 后，可省略 Git 引用。常规发布会自动准备候选、创建并演练恢复快照、切换版本及验证入口，无需重复初始化。
首次接入前的完整备份保留在 `/opt/tools/baox/initialization/backup-before-gate-37660bd-r3`；
后续发布快照保留在 `/opt/tools/baox/recovery-snapshots/`。
