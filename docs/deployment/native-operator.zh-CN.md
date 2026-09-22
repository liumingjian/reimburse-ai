# 原生运维命令行

状态：#263 的只读基线与 #266 的 candidate (候选) 准备。它只操作固定内网主机 `10.250.0.222`，不支持多主机配置。

`@baox/operator` 是维护人员在本机运行的 SSH 命令行。它不推送或合并 Git 状态，也不会安装依赖、停止服务、改写数据、切换发布或打开公网访问。

## 命令

在仓库根目录执行：

```bash
pnpm --filter @baox/operator operator -- plan
pnpm --filter @baox/operator operator -- status
pnpm --filter @baox/operator operator -- doctor
pnpm --filter @baox/operator operator -- logs --lines 200
pnpm --filter @baox/operator operator -- deploy --dry-run
pnpm --filter @baox/operator operator -- prepare [Git 引用] [--relay /本地/source.tar]
```

`plan [Git 引用]` 默认把 `origin/main` 解析为完整提交 SHA。它用该提交生成 Git 归档的 SHA-256，并列出工作树中没有进入归档的改动。显式引用也必须解析为已提交对象。命令不从工作树打包，因此本地未提交内容不会成为发布输入。

`status` 读取当前发布、两个 systemd 服务、数据目录和 maintenance gate (维护闸门) 状态。`doctor` 再读取 Node、隔离 GCC、构建 Python 和闸门包装器，并在发现不能安全进行常规发布的条件时返回非零状态。`logs` 只读取 `baox.service` 与 `baox-caddy.service` 的 journal；`--lines` 必须在 1 到 1000 之间。

`deploy --dry-run [Git 引用]` 只做提交归档和维护闸门兼容性预检。它不会在主机上写入任何内容。当前主机没有维护闸门时，命令拒绝常规发布，并说明首次启用必须是单独、明确、受控的维护变更。它不会执行“检查后停止服务”的路径。

`prepare` 在读取 Git 归档或写入目标之前先检查维护闸门。它只接受已提交的 Git 引用；默认输入是本机由该提交生成的 tar 归档。`--relay` 只能提供与该本机归档 SHA-256 相同的文件，目标主机接收后会再次计算同一 SHA-256。该校验确认的是提交归档，不把归档校验和当作第三方构建资产的签名。

目标主机先取得共享的 `/opt/tools/baox/maintenance/deployment.lock`，再写入 `/opt/tools/baox/maintenance/deployment-journal.json`。锁所有者包含随机代次、进程号和进程起始身份；失联的旧进程不能删除新所有者的锁。准备过程在 `/opt/tools/baox/candidates/<提交前缀>-<归档前缀>/` 解包、构建并校验输出。SSH 中断后，后续同一候选会读取 journal：已经完整校验的归档可以继续构建；构建开始后中断则保留候选并返回恢复要求，不会自动重复不确定的构建。

成功的清单记录提交 SHA、归档 SHA、目标重新校验的 SHA、运行时版本、构建环境文件的 SHA 与键名，以及当前发布、Node 运行时引用和 Caddy/systemd 配置的恢复副本与哈希。环境变量值、令牌和其他机密不会写进清单、归档、日志或 journal。准备不会改动 `current`、共享运行时引用、服务、反向代理或数据目录，也不开放访问或切换版本。

候选准备只报告缺失的 Node、隔离 GCC、构建 Python、pnpm、Caddy、服务账号和受限构建环境，不会安装或修复它们。bootstrap（初始化）是单独的显式操作。`status` 只读取协调状态和 journal；即使发现异常锁或 journal，也不会改写它们。

## 固定主机约定

生产构造固定使用 `root@10.250.0.222`、`/opt/tools/baox` 和 `/opt/tools/baox/data`。命令行没有主机、SSH 用户、数据目录、socket 或令牌选项。测试只能通过 TypeScript 注入受控 `HostTransport`，或向 `SshHostTransport` 注入 runner 与 profile，不能借此改变生产命令的目标。

维护闸门使用 `${BAOX_DATA_DIR}/maintenance-gate.sock`，当前路径是 `/opt/tools/baox/data/maintenance-gate.sock`。SSH 驱动调用主机上的 `/opt/tools/baox/bin/baox-maintenance-gate status`。该包装器从主机本地的受限文件读取令牌，只输出协议 JSON。令牌不能出现在命令参数、计划、日志、归档或诊断输出中。

`status` 可以报告缺失闸门；`doctor` 和 `deploy --dry-run` 将缺失、不可用、协议不兼容或未知写入状态都当作拒绝。后续的 bootstrap、候选准备、恢复快照和切换命令必须沿用这个边界。

## 输出和凭据

所有命令都支持 `--json`。日志和错误输出会遮盖 password、token、secret、credential、cookie 和 authorization 值，以及中文的“临时密码”与“密码”值。这个版本不创建本地凭据文件。后续若必须保留临时管理员凭据，文件必须由创建者用 `0600` 模式写入，且不得进入归档、日志、计划、清单或 journal。

真实主机的验证仅限上述只读命令和 `deploy --dry-run`。常规发布留给后续已验证的维护流程。
