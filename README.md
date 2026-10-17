# reimburse-ai

本机运行的报销应用（baox）：员工在浏览器页面里上传材料、核对整单明细，然后去打印或去报销（自动填报 ERP）。全程不经过 Agent，业务判定全部在本机服务端（`server/`）里。产品方向以 [本地报销应用设计](docs/design/standalone-app.md) 为准；Skill 时期的 ADR 都带有状态行，说明哪些已被取代。

Skill 时期的内核、Skill 目录和分发脚本已在 #197 删除；需要追溯时看 git 提交 `50931a3`（例如 `git show 50931a3:kernel/src/erpform.mjs`）。

## 开发

```bash
pnpm install
pnpm dev          # 服务端 + 页面
pnpm dev:mock     # 只起页面，用 mock 数据
pnpm typecheck
pnpm test         # lint + 各包单元测试（各包并行）
pnpm test:changed <文件>...  # 只跑与这些改动文件相关的单元测试（改到 web/e2e 时才跑相关 e2e，--e2e 强制）
pnpm test:e2e     # Playwright：mock 与真实服务端两个项目
```

Agent 相关的约定见 [AGENTS.md](AGENTS.md)，那是唯一的真源。

## 部署

内网主机（第一阶段，`http://10.250.0.222`）的部署与升级步骤见 [docs/deployment/intranet-phase-1.md](docs/deployment/intranet-phase-1.md)。
