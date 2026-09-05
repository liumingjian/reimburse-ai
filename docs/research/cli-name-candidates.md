# CLI 命令名候选调查

检查日期：2026-09-02（Asia/Shanghai）

## 结论

优先进入实际试用的三个名称是：

1. `baox`：首选。4 个字符，中文员工容易从“报销”联想到用途，也有 `box`（把杂乱材料收进一个工作箱）的次级联想；当前未见 npm 包名或本机命令占用。风险是它不是完整拼音，首次使用仍需要一句说明，且 GitHub 已有一个无关的 JAX 贝叶斯优化同名项目。
2. `bxai`：4 个字符，直接表达“报销 + AI”；当前未见 npm 包名或本机命令占用。风险是 `bx` 对首次接触者不如“报销”完整拼音直观，GitHub 也已有 4 个精确同名仓库。
3. `lipiao`：6 个字符，对应“理票”，最能表达 Agent 把杂乱报销材料整理、关联和编号的能力；当前未见 npm 包名或本机命令占用，GitHub 同名噪声最低。风险是“票”容易让人误以为只处理发票，并且弱化了自动填写 ERP 草稿这一后半段能力。

这只是命名筛选，不是最终定名。建议在实际入口确定后，用真实命令示例让 3-5 位目标员工做一次不解释含义的辨识测试，例如询问看到 `baox <目录>`、`bxai <目录>`、`lipiao <目录>` 时预期它会做什么。

## 候选对比

| 候选 | 长度 | 核心联想 | npm 官方 registry | GitHub 官方搜索 | 本机 PATH | 判断 |
| --- | ---: | --- | --- | --- | --- | --- |
| `baox` | 4 | “报销”的压缩写法；兼有 `box` 的材料箱联想 | `404`，未找到同名包（[registry](https://registry.npmjs.org/baox)） | 前 100 个结果中 5 个仓库精确同名；其中 [fengyiqi/baox](https://github.com/fengyiqi/baox) 是无关的 JAX 贝叶斯优化项目（[API](https://api.github.com/search/repositories?q=baox%20in%3Aname&per_page=100)） | 未找到 | **推荐 1**；短且贴近中文场景，需接受缩写并非一眼自明 |
| `bxai` | 4 | 报销 + AI | `404`，未找到同名包（[registry](https://registry.npmjs.org/bxai)） | 前 100 个结果中 4 个仓库精确同名，但未见报销同领域项目（[API](https://api.github.com/search/repositories?q=bxai%20in%3Aname&per_page=100)） | 未找到 | **推荐 2**；能体现 Agent 属性，但 `bx` 较隐晦 |
| `lipiao` | 6 | “理票”，整理报销材料 | `404`，未找到同名包（[registry](https://registry.npmjs.org/lipiao)） | 前 100 个结果中 1 个仓库精确同名（[API](https://api.github.com/search/repositories?q=lipiao%20in%3Aname&per_page=100)） | 未找到 | **推荐 3**；易读、冲突少，但覆盖不了“填 ERP”的完整含义 |
| `baoxiao` | 7 | “报销”完整拼音 | `404`，未找到同名包（[registry](https://registry.npmjs.org/baoxiao)） | 搜索共有 127 个结果，前 100 个中 45 个仓库精确同名；[xntj-ai/baoxiao](https://github.com/xntj-ai/baoxiao) 也是中国企业发票整理与报销单生成工具（[API](https://api.github.com/search/repositories?q=baoxiao%20in%3Aname&per_page=100)） | 未找到 | 语义最清楚，但同领域撞名明显，不列入前三 |
| `expai` | 5 | expense + AI | `404`，未找到同名包（[registry](https://registry.npmjs.org/expai)） | 前 100 个结果中 9 个仓库精确同名（[API](https://api.github.com/search/repositories?q=expai%20in%3Aname&per_page=100)） | 未找到 | 较国际化，但对中国员工不如拼音直观，读音也不稳定 |
| `rmbs` | 4 | reimburse 去元音缩写 | `404`，未找到同名包（[registry](https://registry.npmjs.org/rmbs)） | 前 100 个结果中 7 个仓库精确同名，多项将 RMBS 用作 Residential Mortgage-Backed Securities（[API](https://api.github.com/search/repositories?q=rmbs%20in%3Aname&per_page=100)） | 未找到 | 短但难读、难记，且已有成熟金融含义，不建议 |
| `reim` | 4 | reimbursement 前缀 | 已有 `reim@3.0.0`，但元数据未声明 `bin`（[registry](https://registry.npmjs.org/reim/latest)） | 前 100 个结果中 5 个仓库精确同名，含报销、语音和图片等不同含义（[API](https://api.github.com/search/repositories?q=reim%20in%3Aname&per_page=100)） | 未找到 | 英文缩写尚可，但无作用域 npm 包名已占用；不建议优先 |
| `bx` | 2 | “报销”首字母 | 已有 `bx@0.6.0`，且明确暴露同名 `bx` 命令（[registry](https://registry.npmjs.org/bx/latest)） | 前 100 个结果中 4 个仓库精确同名，包含 [webdriverio/bx](https://github.com/webdriverio/bx) CLI 和 [bkaradzic/bx](https://github.com/bkaradzic/bx) 基础库（[API](https://api.github.com/search/repositories?q=bx%20in%3Aname&per_page=100)） | 当前机器未找到 | 虽最短，但 npm `bin` 已直接冲突，且搜索噪声很高；排除 |

## 包名与命令名必须分开

npm 的 `package.json` 中，`name` 是发布包名，`bin` 则是“命令名到包内文件”的映射；安装后进入 PATH 的是 `bin` 键，而不必等于包名。npm 也明确允许带作用域的包名，例如 `@scope/package`。参见 npm 官方的 [`package.json` 文档](https://docs.npmjs.com/files/package.json/#bin)和[作用域包发布文档](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/)。

因此：

- 即使 `reim` 这个无作用域包名已被占用，项目仍可使用组织作用域包名，例如 `@<实际组织>/reimburse-ai`，再暴露另一个 `bin` 名。
- 即使 `baox` 等无作用域包名当前返回 `404`，也不需要把发布包命名为 `baox`；使用作用域包能降低抢注和所有权不明确的风险。
- 作用域只隔离 npm **包名**，不会隔离安装到 PATH 的 **命令名**。两个不同包都声明 `bin: { "baox": ... }` 时仍可能在用户机器上覆盖或冲突。
- registry 的 `404` 只是 2026-09-02 的查询快照，不是名称预留、商标检索或对所有 npm 包 `bin` 字段的穷举证明。

## 调查方法与边界

### npm 官方 registry

仓库要求使用 pnpm，因此没有运行 `npm` 命令。由于本机 pnpm 默认 registry 是镜像站，正式检查均显式指定官方地址：

```sh
pnpm view <候选> name version bin repository --json \
  --registry=https://registry.npmjs.org/
```

`bx` 返回 `0.6.0` 及 `bin: { "bx": "bin/bx" }`；`reim` 返回 `3.0.0` 且没有 `bin` 字段；其余 6 个候选均从官方 registry 返回 `404`。查询语义见 [pnpm 官方 `view` 文档](https://pnpm.io/cli/view)。

### GitHub 官方 API

通过 `gh api` 调用 GitHub 官方 Repository Search API：

```sh
gh api -X GET search/repositories \
  -f q='<候选> in:name' \
  -f per_page=100
```

随后在返回的前 100 项中按仓库 `name` 忽略大小写做精确相等过滤。搜索端点及限定符以 [GitHub 官方 Search API 文档](https://docs.github.com/en/rest/search/search#search-repositories)为准。

GitHub 的 `in:name` 是名称包含搜索，并非“严格相等”限定符；表中精确同名数是本地二次过滤结果。结果超过 100 项时，表中数字不是全站精确同名总数。

### 本机命令

在当前 macOS 开发机的现有 PATH 上运行：

```sh
zsh -f -c 'whence -p <候选>'
```

8 个候选均未找到现有可执行文件。这只说明当前机器没有明显冲突，不能代表所有员工电脑、shell alias、Windows 命令或未来安装的软件。

## 未覆盖项

本次没有做商标、域名、公司内部软件目录、其他语言包仓库（PyPI、Homebrew、Cargo 等）或所有 npm 包 `bin` 字段的穷举调查。最终名称确定前，如产品会对外发布，应另做商标与跨生态检索；如只在公司内部分发，应优先检查员工标准镜像和 IT 软件清单。
