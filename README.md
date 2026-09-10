# reimburse-ai

跑在 Claude Code 里的报销助手：整理发票材料、核对明细和项目，生成可交接的准备材料包。
当前开发阶段在交接后停止，等待用户手动 QA；ERP 自动填报属于后续阶段。

架构是「Skill 外壳 + 确定性内核」（见 `docs/adr/`）：判断全在内核里，Skill 只负责把内核吐出来的
JSON 翻译成人话。Node 内核无 npm 依赖，要求 Node ≥ 21；文本 PDF 另需锁定的 Python/uv MarkItDown 运行时。正式页面使用系统默认浏览器；ego-browser 仅用于显式选择的自动化 QA。

## 分发给试用者

```bash
bash scripts/release.sh
```

产出 `release/baox-<版本>-<commit>.zip`，内含四个 Skill 目录和 `INSTALL.md`。
同事解压后把 `baox`、`baox-recover`、`baox-setup`、`extract-reimbursement-images` **四个一起**拷进 Codex 的 `<项目>/.agents/skills/` 或 Claude Code 的 `<项目>/.claude/skills/`，
Node 内核不需要联网或 npm 安装；文本 PDF 运行时须按 `docs/INSTALL.md` 预置并锁定。个人目录 `~/.claude/skills/` 同样可用，但两处都放会出事：
个人目录静默遮蔽项目目录，两边都不报错。试用期统一装项目目录。

安装说明本身在 [`docs/INSTALL.md`](docs/INSTALL.md)，它会跟着包一起发出去。

`scripts/bundle.sh` 是 `release.sh` 的第一步，单独跑可以只产出 `dist/`。它带三道闸：
Skill 目录不许指向目录之外、调试草稿不许混进分发包、每个包必须带着内核入口。

**四个目录必须一起更新。** 三个入口 Skill 目录自带的那份内核就地运行，`baox` 就是那个目录下的
`kernel/bin/baox.mjs`（绝对路径；`CLAUDE_SKILL_DIR` 这个变量并不存在，见
[ADR-0010](docs/adr/0010-kernel-side-command-guard.md)）—— 没有安装这一步，
也没有第二份内核可以对不上。
数据在 `~/.baox`（`BAOX_HOME` 可覆盖）。

## 开发

```bash
node --test kernel/test/*.test.mjs    # Node 内核测试，无 npm 依赖
bash scripts/qa-dist.sh               # 分发链路验收：打包、内核入口、数据目录迁移、压缩包端到端
```

**改了内核就要抬 `kernel/VERSION`。** 它只用于把试用者报回来的问题钉到具体某一版：
`doctor` 每次都报它，一份没有版本号的问题报告基本查不动。

Agent 相关的约定见 [AGENTS.md](AGENTS.md)，那是唯一的真源。
