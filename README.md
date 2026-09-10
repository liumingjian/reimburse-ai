# reimburse-ai

跑在 Claude Code 里的报销助手：整理发票材料、核对、填进 ERP 的费用报销单。
提交和最终保存永远是人来做。

架构是「Skill 外壳 + 确定性内核」（见 `docs/adr/`）：判断全在内核里，Skill 只负责把内核吐出来的
JSON 翻译成人话。确定性内核零依赖，Node ≥ 21，通过 CDP 驱动一个专用的 Chrome 实例；
可选的本地 OCR 运行时独立安装。

## 分发给试用者

```bash
bash scripts/release.sh
```

产出 `release/baox-<版本>-<commit>.zip`，内含四个 Skill 目录和 `INSTALL.md`。
同事解压后把 `baox`、`baox-recover`、`baox-setup`、`extract-reimbursement-images` **四个一起**拷进 `<项目>/.claude/skills/` 即可，
不需要联网、不需要装任何依赖。个人目录 `~/.claude/skills/` 同样可用，但两处都放会出事：
个人目录静默遮蔽项目目录，两边都不报错。试用期统一装项目目录。

安装说明本身在 [`docs/INSTALL.md`](docs/INSTALL.md)，它会跟着包一起发出去。

`scripts/bundle.sh` 是 `release.sh` 的第一步，单独跑可以只产出 `dist/`。它带三道闸：
Skill 目录不许指向目录之外、调试草稿不许混进分发包、每个包必须带着内核入口。

**四个目录必须一起更新。** 三个流程 Skill 自带的那份内核就地运行，`baox` 就是那个目录下的
`kernel/bin/baox.mjs`（绝对路径；`CLAUDE_SKILL_DIR` 这个变量并不存在，见
[ADR-0010](docs/adr/0010-kernel-side-command-guard.md)）—— 没有安装这一步，
也没有第二份内核可以对不上。
数据在 `~/.baox`（`BAOX_HOME` 可覆盖）。

用户要求重置时，`baox reset` 直接清除全部本地业务信息及旧目录副本，无需再次确认。
程序、运行依赖、原始材料、共享浏览器登录态和 ERP 远端单据保留；详见[重置范围](docs/design/reset.md)。

## 开发

```bash
node --test kernel/test/*.test.mjs    # 内核测试，零依赖
bash scripts/qa-dist.sh               # 分发链路验收：打包、内核入口、数据目录迁移、压缩包端到端
```

**改了内核就要抬 `kernel/VERSION`。** 它只用于把试用者报回来的问题钉到具体某一版：
`doctor` 每次都报它，一份没有版本号的问题报告基本查不动。

Agent 相关的约定见 [AGENTS.md](AGENTS.md)，那是唯一的真源。
