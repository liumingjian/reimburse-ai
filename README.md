# reimburse-ai

本机运行的报销应用（baox）：员工在浏览器页面里上传材料、核对整单明细，然后去打印或去报销（自动填报 ERP）。全程不经过 Agent，业务判定全部在确定性内核里。产品方向以 [本地报销应用设计](docs/design/standalone-app.md) 为准；Skill 时期的 ADR 都带有状态行，说明哪些已被取代。

旧的 Skill 分发链路（`scripts/release.sh`、[`docs/INSTALL.md`](docs/INSTALL.md)、`skills/`）在本地应用接管之前仍保留。

## 开发

```bash
node --test kernel/test/*.test.mjs    # Node 内核测试，无 npm 依赖，要求 Node ≥ 21
bash scripts/qa-dist.sh               # Skill 分发链路验收（随 Skill 一起退役）
```

**改了内核就要抬 `kernel/VERSION`。** 它只用于把问题钉到具体某一版：`doctor` 每次都报它。

Agent 相关的约定见 [AGENTS.md](AGENTS.md)，那是唯一的真源。

用户明确要求重置时，`baox reset` 立即清理本地业务数据，保留运行依赖、原始材料和 ERP 远端单据。详见 [重置范围](docs/design/reset.md)。
