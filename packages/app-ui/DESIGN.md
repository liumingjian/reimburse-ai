---
version: alpha
name: baox-standalone-app
description: "本地报销应用（docs/design/standalone-app.md）的视觉基础。骨架取自 Linear：单一薰衣草蓝强调色、hairline 边框加表面阶梯承载层级、600/400 字重、8px 按钮与 12px 面板圆角、4px 间距基数。Linear 原件只记录了深色营销站，本文用它自带的 inverse 表面色反转为浅色，因为页面旁边永远是白底票据。表格与表单的密度细节取自 Airtable：hairline 分隔线、12px 行内距、44px 输入高度。"

sources:
  - slug: linear.app
    file: ../../prototypes/design-md/linear.app.DESIGN.md
    role: 骨架（强调色、表面阶梯、字重、圆角、间距）
  - slug: airtable
    file: ../../prototypes/design-md/airtable.DESIGN.md
    role: 表格与表单细节（分隔线、行距、输入高度、近黑主文字）
fetched: 2026-09-11
command: "npx getdesign@latest add <slug>"

colors:
  primary: "#5e6ad2"
  primary-hover: "#4f5bc4"
  primary-pressed: "#4551b3"
  primary-soft: "#eef0fb"
  on-primary: "#ffffff"
  focus-ring: "rgb(94 106 210 / 40%)"
  canvas: "#f6f7f7"
  surface-1: "#ffffff"
  surface-2: "#f5f6f6"
  surface-3: "#eeeff1"
  hairline: "#e3e5e8"
  hairline-strong: "#cfd2d7"
  ink: "#17181c"
  ink-muted: "#4b4f57"
  ink-subtle: "#8a8f98"
  ink-tertiary: "#b1b5bd"
  success: "#1f8a3a"
  success-soft: "#e6f5ea"
  warning: "#9a5b00"
  warning-soft: "#fff3dc"
  danger: "#b3392f"
  danger-soft: "#fbe9e7"
  overlay: "rgb(23 24 28 / 40%)"

typography:
  title:
    fontFamily: text
    fontSize: 22px
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: -0.4px
  headline:
    fontFamily: text
    fontSize: 17px
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: -0.2px
  body:
    fontFamily: text
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0
  caption:
    fontFamily: text
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: 0
  button:
    fontFamily: text
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: 0
  mono:
    fontFamily: mono
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0

fonts:
  text: '-apple-system, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif'
  mono: '"SF Mono", Menlo, "JetBrains Mono", ui-monospace, monospace'

rounded:
  xs: 4px
  md: 8px
  lg: 12px
  pill: 9999px

spacing:
  xxs: 4px
  xs: 8px
  sm: 12px
  md: 16px
  lg: 24px
  xl: 32px
  xxl: 48px

layout:
  content-max-width: 1200px
  hairline-width: 1px
  focus-ring-width: 2px
  group-bar-width: 3px
  control-height-sm: 28px
  control-height-lg: 44px
  stage-index-size: 20px
  page-min-width: 320px
  dropzone-min-height: 200px
  file-size-width: 72px
  split-list-width: 300px
  detail-preview-width: 260px
  dialog-width: 440px
  checkbox-size: 16px

components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: 8px 14px
    minHeight: 36px
  button-secondary:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.ink}"
    border: "1px {colors.hairline-strong}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: 8px 14px
    minHeight: 36px
  button-tertiary:
    backgroundColor: transparent
    textColor: "{colors.ink-muted}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: 8px 10px
  text-input:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.ink}"
    border: "1px {colors.hairline-strong}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: 8px 12px
    height: 36px
  panel:
    backgroundColor: "{colors.surface-1}"
    border: "1px {colors.hairline}"
    rounded: "{rounded.lg}"
    padding: 20px
  data-table-row:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    padding: 10px 12px
    divider: "1px {colors.hairline}"
  status-badge:
    backgroundColor: "{colors.surface-3}"
    textColor: "{colors.ink-muted}"
    typography: "{typography.caption}"
    rounded: "{rounded.pill}"
    padding: 2px 8px
  sidebar:
    backgroundColor: "{colors.canvas}"
    width: 232px
    borderRight: "1px {colors.hairline}"
  top-bar:
    backgroundColor: "{colors.surface-1}"
    height: 52px
    borderBottom: "1px {colors.hairline}"
---

## 用途

这份文件是 `@baox/app-ui` 所有页面的视觉依据，也是唯一的样式来源。改动页面样式前先改这里，然后运行
`pnpm --filter @baox/app-ui tokens`：`scripts/build-tokens.mjs` 会把 front matter 生成为
`src/styles/tokens.css` 里的 CSS 自定义属性。页面 CSS 只允许引用这些自定义属性，不写字面颜色、字号、圆角和尺寸。

命名规则：`colors.x` 生成 `--color-x`，`fonts.x` 生成 `--font-x`，`typography.x` 生成 `--text-x-size` /
`-weight` / `-line` / `-tracking` / `-family` 以及可直接用于 `font:` 的 `--text-x`，`rounded.x` 生成 `--radius-x`，
`spacing.x` 生成 `--space-x`，`layout.x` 生成 `--layout-x`，`components.name.prop` 生成 `--name-prop`（prop 转 kebab-case），
其中 `{group.key}` 形式的引用会解析成 `var(--…)`。

两份 getdesign 原件存放在 `prototypes/design-md/`，逐字保留，用于溯源；本文件只写本项目用到的部分，以及与原件不同之处的理由。

## 从 Linear 继承什么

- **单一强调色**：`{colors.primary}` 薰衣草蓝 #5e6ad2 直接沿用。它只出现在主按钮、焦点环、当前导航项和链接强调上，不做背景、不做卡片填充。
- **表面阶梯代替阴影**：canvas → surface-1 → surface-2 → surface-3 承载层级，边框用 1px hairline。整个应用不用投影；唯一例外是弹层，用 `{colors.overlay}` 遮罩。
- **字重**：标题 600、正文 400、按钮 500。不用 700。
- **圆角**：按钮和输入 8px，面板 12px，小标签 4px，状态徽标 pill。这是整套应用的固定规则，不再引入别的圆角。
- **间距**：4px 基数。面板内距 20px，表格单元格 10px 12px，页面内容最大宽 1200px。
- **等宽字体只用于数字与编号**：金额、发票号码、日期、序号用 `{typography.mono}`，方便对齐和核对；其余一律正文字体。

## 为什么反转成浅色

Linear 原件只记录深色营销站，并明确写了"不发布浅色版"，也没有浅色 token。这个应用的核心页面是票据对照与打印稿预览，旁边永远是白底票据，深色界面会让票据刺眼、也让打印预览失真。因此：

- 用 Linear 自带的 inverse 表面色做起点：`inverse-surface-2` #f6f7f7 作 canvas，`inverse-canvas` #ffffff 作 surface-1，`inverse-surface-1` #f5f6f6 作 surface-2。
- 文字用 Linear 的 ink-subtle #8a8f98 做三级文字，一级文字取近黑 #17181c（Airtable 的 ink #181d26 同一思路）。
- 主按钮的悬停态在浅色上要变深而不是变浅，所以 hover 用 #4f5bc4，pressed 用 #4551b3，不再用原件的 #828fff。

## 从 Airtable 借什么

只借表格与表单的密度，不借它的多彩签名卡片和近黑主按钮：

- 表格用 1px hairline 分隔行，不画列线；表头 12px 灰字，行内距 10px 12px；同一发票的多行以左侧 3px 色条归组而不是加框。
- 输入框高 36px（Airtable 的 44px 针对触屏，桌面应用压到 36px），焦点环 2px `{colors.focus-ring}`。
- 主按钮一屏一个。"去打印"和"去报销"两个按钮并列时，两个都是主动作，用同一样式并排，不分主次。

## 布局尺寸

`layout` 组收纳页面 CSS 需要、又不属于颜色/字号/圆角/间距的几个固定尺寸：内容最大宽、hairline 与焦点环粗细、归组色条宽度、
小号与大号控件高度、阶段序号圆点尺寸、页面最小宽度、上传拖放区最小高度、文件列表大小列宽、待确认项左栏宽度、原件预览栏宽度、
弹层宽度、复选框尺寸。新的尺寸先加到这里，再在 CSS 里引用。

## 语义色

界面只在表达真实状态时用语义色，而且都取低饱和：

| 状态 | 用法 |
| --- | --- |
| `{colors.success}` | 校验通过、已确认、ERP 回读一致 |
| `{colors.warning}` | 待确认项、缺支付截图、回读需人工核对 |
| `{colors.danger}` | 校验不通过、写入中止、原件缺失 |

不用彩色圆点做装饰；徽标里的颜色必须对应上表的一种状态。

## 不做的事

- 不用渐变、光晕、投影。
- 不用第二种强调色。
- 不在标题前加小字眉题。
- 不用 em-dash 和 en-dash，范围写作 `No.2-4`。
- 不用手绘 SVG 图标；原型阶段只用文字和少量 Unicode 箭头。
