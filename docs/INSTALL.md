# baox 安装与试用

baox 是一套适配 Codex 和 Claude Code 的报销助手：整理发票、核对明细和项目，自动保存 ERP 报销草稿。
当前流程在草稿保存并严格回读后结束；提交、审批和付款仍由用户决定。

这份文档是给试用的同事看的。Node 内核没有 npm 依赖；环境准备会检查并安装随包锁定的 MarkItDown 与受管本地 OCR 运行时。文本转换和图片 OCR 在本机执行，不把材料发送给转换器或云端 OCR；ERP 前置核验只读，确认后的草稿写入由内核按一次性状态步骤执行。

## 你需要先有

| | |
|---|---|
| macOS | 目前只在 macOS 上验证过 |
| Node.js **21 或更高** | `node -v` 看一下。没有就 `brew install node`，或去 https://nodejs.org 下 LTS 安装包 |
| 文本 PDF 与图片 OCR 运行时 | 环境准备按随包 lockfile 和固定版本安装到 `~/.baox` 下的受管目录；不能使用全局 Python 或评估机临时虚拟环境 |
| 系统默认浏览器 | 页面按系统默认设置打开；ERP 只读自动化还需浏览器提供相应能力与权限，不要求普通用户安装 ego |
| ERP 账号 | 用你本人的账号，登录这件事自始至终在你手里 |
| Codex 或 Claude Code | 已登录可用 |

## 安装

解压拿到的压缩包，里面有四个目录。**试用期请装进项目目录**。

Codex：

```bash
cd <你打算用来报销的目录>
mkdir -p .agents/skills
cp -R baox baox-recover baox-setup extract-reimbursement-images .agents/skills/
```

Claude Code：

```bash
cd <你打算用来报销的目录>          # 例如 ~/projects/baoxiao
mkdir -p .claude/skills
cp -R baox baox-recover baox-setup extract-reimbursement-images .claude/skills/
```

两者都要使用时，只保留一份实体目录。例如先按 Claude Code 路径安装，再为 Codex 建立链接：

```bash
mkdir -p .agents/skills
for skill in baox baox-recover baox-setup extract-reimbursement-images; do
  ln -s "../../.claude/skills/$skill" ".agents/skills/$skill"
done
```

拷完后在同一个项目目录里重开 Codex 或 Claude Code 会话。

### 三条规矩

**一、四个必须一起拷。** 三个入口 Skill 自带同一份内核，图片字段提取 Skill 自带 OCR 执行代码；缺少任一个都会让对应流程中断。

Node 内核随 Skill 文件运行，不需要 npm 安装。环境准备先用可用的 uv 按随包的 `kernel/src/pdf-markdown-runtime/pyproject.toml` 和 `uv.lock` 把 MarkItDown 安装到 `~/.baox/runtimes/markitdown/v1`，再把固定版本的 `extract-reimbursement-images` OCR 安装到 `~/.baox/ocr-runtime/v1`。解析阶段只使用这些受管目录，不会首次下载；uv 不可用、同步失败、安装器失败或锁文件不匹配时，流程停止并报告原因。PNG/JPG 默认直接走模型视觉；明确选择 `ocr-assisted` 时才先走受管本地 OCR，缺字段或候选校验失败的项目再进入视觉复核。无论 PDF 还是图片，识别候选都在最终整单明细清单中统一确认；没有可靠文字的 PDF 保留待办。

**二、四个必须在同一个位置，而且来自同一次打包。** Codex 使用 `.agents/skills/`，Claude Code 使用
`.claude/skills/`；两者同时使用时让其中一处链接到另一处，**不要维护两份独立副本**。

**三、个人目录会静默遮蔽项目目录。** Claude Code 的优先级是「个人 > 项目」，同名 Skill 只有
优先级高的那一个会被加载，**另一个既不会报错也不会出现在 `/skills` 里**，Skill 自己也无从察觉
自己被遮蔽了。所以如果你以前在 `~/.claude/skills/` 下装过 baox，现在又往项目目录里放了一份新的，
跑的仍然是旧的那一份。装之前先看一眼：

```bash
ls -d ~/.claude/skills/baox*        # 有东西就说明存在遮蔽风险
```

有的话，把个人目录里那套删掉（或挪走）再装项目目录这套。也可以在 Claude Code 里跑
`/skill-doctor`（v2.1.252 以上），它会直接告诉你每个 Skill 实际是从哪个目录加载的。

> 这不是假想的：第一次真机试用栽的就是它——个人目录里一份半年前的 `baox-setup` 遮蔽了项目目录里
> 的新版，跑的自始至终是那份旧的，结果登录了也永远显示"未登录"，而哪一层都不会告诉你跑错了目录。

等整套框架稳定之后，我们会改成推荐装在个人目录（一次安装，所有项目可用）。现在还在试用期，
装项目目录更容易看清楚跑的到底是哪一份。

### Claude Code 可选：再加一道守卫

baox 的内核自己会拒掉模型拼出来的命令——**这一层不用装，拷进去就生效**。
下面这段是可选的外层，好处是那条命令连进程都不会起。

在 `<项目>/.claude/settings.json` 里加上（文件不存在就新建）：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command",
            "command": "node <项目绝对路径>/.claude/skills/baox/hooks/guard.mjs" }
        ]
      }
    ]
  }
}
```

路径要写成绝对路径。加完重开一个 Claude Code 会话。
已经有 `hooks` 配置的话，把这一项并进现有的 `PreToolUse` 数组里，别整段覆盖。

### Claude Code auto mode：把权限一次配好

Claude Code 的 **auto mode**（不逐条问你、可以放着自己跑的那个模式）会把每个动作交给一个
分类器审。分类器不认识 baox，它看到的是「一目录发票」加「一条要读它们的命令」，判不出目的地
是本机还是外网，于是按**数据外泄**拦掉。真机第一次跑就卡在这里：

```
Denied by auto mode classifier. [Data Exfiltration] `ocr-submit` would send sensitive
reimbursement materials from .../resources to an unconfirmed destination
```

拦下来之后 **auto mode 不会弹权限提示**（它的整个卖点就是不问你），所以现场没有任何办法放行，
只能退出去改配置重来。装好之后先跑一次这个，就不会遇到：

```bash
cd <你报销用的那个目录>
node <解压出来的目录>/install-permissions.mjs
```

它做两件事，都会先备份、只加不删：

1. 往 `<项目>/.claude/settings.json` 写一批**窄规则**——精确到「哪个解释器 + 哪个脚本 +
   哪个子命令」。必须这么窄：官方文档说 auto mode 只保留窄规则并在分类器之前解析掉，而
   `Bash(node *)` 这类**通配解释器**的宽规则会被**挂起**，写了也白写。
2. 往 `~/.claude/settings.json` 合并一段 `autoMode`，用大白话告诉分类器：这些发票只在你本机的
   材料目录、`~/.baox` 和公司 ERP 之间流转，`ocr-submit` 这种名字里带「submit」的子命令
   只是往本机任务工作区里写。这一段**只能放在用户级设置里**——分类器不读项目里的
   `autoMode`（怕仓库里的文件自己给自己发通行证）。

跑完还有两步收尾，脚本会再提醒你一次：

- **信任这个工作区**：在该目录里交互式开一次 `claude`、接受信任对话框。不然项目里的规则会被
  整段忽略，Claude Code 只会安静地打印一行 `Ignoring N permissions.allow entry … this
  workspace has not been trusted`。
- **验一眼**：`claude auto-mode config`，看 `environment` 和 `allow` 里有没有那几条。

> 不想用 auto mode 也行：用会逐条问你的模式（Shift+Tab 切换），那些命令会正常弹提示，你点允许
> 即可。但那样就没法放着不管了。

## 第一次使用

在 Codex 或 Claude Code 里说一句：

> 帮我把 baox 环境装一下

它会走完体检 → 准备已声明的 PDF/OCR 运行时 → 在默认浏览器打开页面 → 读取已登录身份 → 试一次选择界面。**没有"安装 Node 内核"这一步**——
拷进去的目录就是跑起来的那一份。中间有三步要你动手：
需要你本人在默认浏览器里登录 ERP，并在出现本地选择页时完成提交。登录身份可完整读取时会自动绑定，不重复询问是否本人。

身份确认页上的姓名、登录账号和账套，都是 baox 自己从 ERP 页面读出来的，你只能认或不认，
不用打字。确认之后，这台机器上的 baox 只替这个身份报销；换别人登录会被直接拦住。
真要换人用（比如工作交接），手上没有进行中的任务时，说一句「重新确认 baox 的报销人身份」即可。

页面打开跟随系统默认设置。当前 V1 ERP 适配范围为 Chromium 浏览器：Chrome 和 Edge；Safari 及其他浏览器仍可打开页面，但 ERP 自动读取和写入会报告能力不支持。

在 macOS 上，自动读取 ERP 还需默认浏览器允许通过 Apple Events 执行 JavaScript；本阶段内核仅使用它做只读查询。例如 Chrome 若提示该能力已关闭，可在“显示（View）→ 开发者（Developer）→ 允许 Apple 事件中的 JavaScript”中自行开启。内核会区分读取权限、浏览器能力和登录问题；打开页面成功不代表这些检查已经通过。浏览器设置由你决定，安装脚本不会替你修改。

## 日常使用

> 帮我报销 ~/Downloads/8月出差

它会盘点材料、识别发票、请你确认分类明细，再从本人维护的项目中选择，最后生成发票专属目录、明细 Markdown、同源 JSON 和校验清单。
缺少字段或证据时会明确列出。材料充分并由你确认后，baox 会在一个可接管的 Chromium ERP 页面中自动导入发票、选择“不生成费用明细”、填写明细并保存草稿。若默认浏览器没有 CDP 自动化连接，内核会自动启动使用独立 baox profile 的 Chrome/Edge 窗口并打开 ERP；你只需在该窗口登录一次，后续写入和恢复沿用同一页面，不切换到 ego。

**你只需要认识 `baox` 一个。** 装的是四个目录，另外三个（`baox-setup` 环境准备、
`extract-reimbursement-images` 图片字段提取、`baox-recover` 写入善后）由 baox 自己在需要的时候调起来，不用你去挑该用哪一个，
也不用你知道它们存在。少的那两个目录不能省——baox 调不到就走不下去。

## 你的数据在哪

全部在你自己的机器上，`~/.baox/`（`BAOX_HOME` 指到别处的话就在别处）：

- `tasks/` —— 任务工作区，**发票副本、识别结果及准备材料包**
- `logs/` —— 日志
- `runtimes/markitdown/v1/` —— 锁定的 MarkItDown 运行时
- `ocr-runtime/v1/` —— 锁定的本地图片 OCR 运行时

也就是说这里面是真的发票。要清理直接删这个目录；删掉之后重跑一次环境准备即可。
账号密码只经过你自己的手，任何时候都不写进这些文件。

**从 0.9.x 升上来的话**：baox 第一次运行时会把旧的 `~/Library/Application Support/baox/`
整份**拷**到 `~/.baox/`，并在那条命令的输出里告诉你迁到哪了。只做一次。旧目录原样留着，
装回 0.9.x 还能接着用；确认新版一切正常之后，那个旧目录可以自己删掉。

## 更新到新版本

把新的四个目录整份覆盖进**原来那个位置**（四个一起），然后重开一个 Claude Code 会话。就这些——
没有第二步，覆盖完跑的就是新的那一份。

你的数据不在 Skill 目录里，覆盖不会动到任何任务、发票或登录状态。

## 报问题

请附上这一句的输出，里面有版本号：

> 帮我跑一下 baox 体检

没有版本号的问题定位不到具体是哪一版，基本查不动。再加上你当时说了什么、它做了什么、
你期望它做什么，就够了。

## 目前的边界

- 普通页面使用系统默认浏览器；V1 只支持 Chrome/Edge Chromium，ERP 读取能力或权限不足时明确阻塞，不能仅凭打开页面就认为已登录
- ERP 草稿写入和恢复使用 Chrome/Edge 共用的 Chromium CDP 适配器；默认浏览器没有连接时由内核自动准备独立窗口，写入或保存状态未知时进入只读恢复流程，不自动重试
- ego-browser 是显式自动化 QA 适配，不是正式使用的前提；完整准备流程的用户手动 QA 尚待完成
- 只对着一套 ERP 验证过
- 当前终点是 ERP 草稿保存并通过严格回读；提交、审批和付款仍由用户在 ERP 中完成
