# reimburse-ai

跑在 Claude Code 里的报销助手：整理发票材料、核对、填进 ERP 的费用报销单。
提交和最终保存永远是人来做。

架构是「Skill 外壳 + 确定性内核」（见 `docs/adr/`）：判断全在内核里，Skill 只负责把内核吐出来的
JSON 翻译成人话。内核零依赖，Node ≥ 21，通过 CDP 驱动一个专用的 Chrome 实例。

## 分发给试用者

```bash
bash scripts/release.sh
```

产出 `release/baox-<版本>-<commit>.zip`，约 1MB，内含三个 Skill 目录和 `INSTALL.md`。
同事解压后把 `baox`、`baox-recover`、`baox-setup` **三个一起**拷进 `<项目>/.claude/skills/` 即可，
不需要联网、不需要装任何依赖。个人目录 `~/.claude/skills/` 同样可用，但两处都放会出事：
个人目录静默遮蔽项目目录，两边都不报错。试用期统一装项目目录。

安装说明本身在 [`docs/INSTALL.md`](docs/INSTALL.md)，它会跟着包一起发出去。

`scripts/bundle.sh` 是 `release.sh` 的第一步，单独跑可以只产出 `dist/`。它带三道闸：
Skill 目录不许指向目录之外、调试草稿不许混进分发包、每个包必须带着启动器。

**三个目录必须一起更新。** 它们共用安装在数据目录里的同一份内核；版本一旦对不上，
`kernel/bin/launch.mjs` 会在第一条命令上硬阻塞（`version_drift`），而不是带着错位的版本往下跑。

## 开发

```bash
node --test kernel/test/*.test.mjs    # 内核测试，零依赖
bash scripts/qa-dist.sh               # 分发链路验收：打包、启动器、版本闸、压缩包端到端
```

**改了内核就要抬 `kernel/VERSION`。** 版本闸比的就是这个数；不抬的话，试用者机器上装着的旧内核
会被判成「一致」而继续跑——那正是这道闸要防的情况。

Agent 相关的约定见 [AGENTS.md](AGENTS.md)，那是唯一的真源。
