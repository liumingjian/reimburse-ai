# baox 安装与试用

baox 是一套跑在 Claude Code 里的报销助手：你把发票丢给它，它整理材料、核对、填进 ERP 的费用报销单。
**它不替你提交，也不替你确认**——每一个有后果的动作都要你亲手点。

这份文档是给试用的同事看的。材料处理始终在本机完成、不上传图片；可选的本地 OCR 加速
会在首次启用时联网安装 Python 依赖和模型，未安装或安装失败时自动回退到模型视觉。

## 你需要先有

| | |
|---|---|
| macOS | 目前只在 macOS 上验证过 |
| Node.js **21 或更高** | `node -v` 看一下。没有就 `brew install node`，或去 https://nodejs.org 下 LTS 安装包 |
| Python **3.11**（OCR 加速可选） | 没有时先安装；不启用本地 OCR 仍可走模型视觉 |
| Google Chrome | 会另开一个**专用实例**，和你日常那个 Chrome 互不干扰 |
| ERP 账号 | 用你本人的账号，登录这件事自始至终在你手里 |
| Claude Code | 已登录可用 |

## 安装

解压拿到的压缩包，里面有四个目录。Claude Code 认两个位置，**试用期请装进项目目录**：

```bash
cd <你打算用来报销的目录>          # 例如 ~/projects/baoxiao
mkdir -p .claude/skills
cp -R baox baox-recover baox-setup extract-reimbursement-images .claude/skills/
```

拷完重开一个 Claude Code 会话（在同一个目录里启动）。

### 三条规矩

**一、四个必须一起拷。** 三个流程 Skill 带着同一版内核；第四个是图片提取深模块。
少一个就可能在环境准备、图片提取或写入善后时失去对应说明书。

**二、四个必须在同一个位置，而且来自同一次打包。** 个人目录 `~/.claude/skills/` 和项目目录
`<项目>/.claude/skills/` 都是合法安装位置，但**不要各放一部分**。

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

### 可选：再加一道守卫

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

### 必做：把权限一次配好

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

### 可选：启用本地 OCR 加速

在 Apple Silicon Mac 上，先运行不带 `--yes` 的命令查看版本、来源、预计下载量和缓存位置；
确认后再加 `--yes`。安装进入 `~/.baox/ocr-runtime/v1/`，不修改全局 Python：

```bash
node .claude/skills/extract-reimbursement-images/runtime/install-runtime.mjs
node .claude/skills/extract-reimbursement-images/runtime/install-runtime.mjs --yes
```

当前试点默认锁定 RapidOCR 3.9.2、PP-OCRv6 small 和 ONNX Runtime 1.23.2；PaddleOCR 与
PP-OCRv6 medium 只保留作基准对照。
首批分发仍只承诺 Apple Silicon macOS。
首次安装与模型下载需要联网；正式识别使用本地缓存。未安装时图片流程自动改用模型视觉。

在 Claude Code 里说一句：

> 帮我把 baox 环境装一下

它会走完体检 → 起专用 Chrome → 确认身份 → 试一次选择界面。**没有"安装内核"这一步**——
拷进去的目录就是跑起来的那一份。中间有三步要你动手：
**在新开的那个 Chrome 窗口里登录 ERP**、**在身份确认页上点「是我本人」**，以及**在自检页上点一次提交**。
三步都完成了才算装好。

身份确认页上的姓名、登录账号和账套，都是 baox 自己从 ERP 页面读出来的，你只能认或不认，
不用打字。确认之后，这台机器上的 baox 只替这个身份报销；换别人登录会被直接拦住。
真要换人用（比如工作交接），手上没有进行中的任务时，说一句「重新确认 baox 的报销人身份」即可。

## 日常使用

> 帮我报销 ~/Downloads/8月出差

它会盘点材料、认发票、问你拿不准的地方，一路走到把单子填进 ERP。
**最后的保存和提交仍然是你自己按。**

**你只需要认识 `baox` 一个。** 另外三个（`baox-setup`、`baox-recover` 和图片字段提取）
都由 baox 在需要时调用，不需要你选择。

## 你的数据在哪

全部在你自己的机器上，`~/.baox/`（`BAOX_HOME` 指到别处的话就在别处）：

- `chrome-profile/` —— 专用 Chrome 的独立 profile（调试端口只绑 `127.0.0.1`，不碰你日常的 profile）
- `tasks/` —— 任务工作区，**发票副本和识别结果**
- `logs/` —— 日志

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

- 只在 macOS + Google Chrome 上验证过（Windows 有代码路径，没实测）
- 本地 OCR 试点只支持 Apple Silicon macOS；其他平台回退模型视觉
- 只对着一套 ERP 验证过
- 提交和最终保存永远是人来做，这是设计，不是待办
