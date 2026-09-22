# 原生运维命令行

状态：#263 的只读基线。它只操作固定内网主机 `10.250.0.222`，不支持多主机配置。

`@baox/operator` 是维护人员在本机运行的 SSH 命令行。它不推送或合并 Git 状态，也不会在这个阶段安装依赖、准备候选发布、停止服务、改写数据、切换发布或打开公网访问。

## 命令

在仓库根目录执行：

```bash
pnpm --filter @baox/operator operator -- plan
pnpm --filter @baox/operator operator -- status
pnpm --filter @baox/operator operator -- doctor
pnpm --filter @baox/operator operator -- logs --lines 200
pnpm --filter @baox/operator operator -- deploy --dry-run
```

`plan [Git 引用]` 默认把 `origin/main` 解析为完整提交 SHA。它用该提交生成 Git 归档的 SHA-256，并列出工作树中没有进入归档的改动。显式引用也必须解析为已提交对象。命令不从工作树打包，因此本地未提交内容不会成为发布输入。

`status` 读取当前发布、两个 systemd 服务、数据目录和 maintenance gate (维护闸门) 状态。`doctor` 再读取 Node、隔离 GCC、构建 Python 和闸门包装器，并在发现不能安全进行常规发布的条件时返回非零状态。`logs` 只读取 `baox.service` 与 `baox-caddy.service` 的 journal；`--lines` 必须在 1 到 1000 之间。

`deploy --dry-run [Git 引用]` 只做提交归档和维护闸门兼容性预检。它不会在主机上写入任何内容。当前主机没有维护闸门时，命令拒绝常规发布，并说明首次启用必须是单独、明确、受控的维护变更。它不会执行“检查后停止服务”的路径。

## 固定主机约定

生产构造固定使用 `root@10.250.0.222`、`/opt/tools/baox` 和 `/opt/tools/baox/data`。命令行没有主机、SSH 用户、数据目录、socket 或令牌选项。测试只能通过 TypeScript 注入受控 `HostTransport`，或向 `SshHostTransport` 注入 runner 与 profile，不能借此改变生产命令的目标。

维护闸门使用 `${BAOX_DATA_DIR}/maintenance-gate.sock`，当前路径是 `/opt/tools/baox/data/maintenance-gate.sock`。SSH 驱动调用主机上的 `/opt/tools/baox/bin/baox-maintenance-gate status`。该包装器从主机本地的受限文件读取令牌，只输出协议 JSON。令牌不能出现在命令参数、计划、日志、归档或诊断输出中。

`status` 可以报告缺失闸门；`doctor` 和 `deploy --dry-run` 将缺失、不可用、协议不兼容或未知写入状态都当作拒绝。后续的 bootstrap、候选准备、恢复快照和切换命令必须沿用这个边界。

## 输出和凭据

所有命令都支持 `--json`。日志和错误输出会遮盖 password、token、secret、credential、cookie 和 authorization 值，以及中文的“临时密码”与“密码”值。这个版本不创建本地凭据文件。后续若必须保留临时管理员凭据，文件必须由创建者用 `0600` 模式写入，且不得进入归档、日志、计划、清单或 journal。

真实主机的验证仅限上述只读命令和 `deploy --dry-run`。常规发布留给后续已验证的维护流程。
