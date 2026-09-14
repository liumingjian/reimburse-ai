# 开源 OCR 方案对图片材料提取的适用性

> **状态：选型已定（2026-09-11）。** 由 [ADR-0013](../adr/0013-managed-local-ocr-for-image-fields.md) 与[本地报销应用](../design/standalone-app.md)确定为受管 RapidOCR；下文推荐的 PaddleOCR.js（浏览器 WASM）未采用。

**研究日期：2026-09-09。** 本文只回答一个设计问题：成熟的本地 OCR 能否成为图片材料字段候选提取 Skill 的实现基础。结论不是选型 ADR，也不修改现有流程。

## 结论

可以试，但不应把 OCR 当成已经解决“发票金额、车票起止点/日期/乘车人/金额”的现成组件。

1. **首选验证 PaddleOCR，部署原型首选官方 PaddleOCR.js。** PP-OCR 对简体中文、英文和数字有直接模型支持；官方浏览器 SDK 能用 ONNX Runtime Web 的 WASM 后端在客户端推理，并返回每行文字、坐标和置信度。这最接近当前 Node + Chrome 技术栈，也最容易把原图、文字框和分数一起留作可复核证据。[PaddleOCR.js 文档](https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/inference_deployment/cross_platform/browser.md)
2. **RapidOCR 是第二个值得跑同一数据集的基线。** 它把 PaddleOCR 系列模型转成 ONNX，默认中英文，强调离线、多平台部署；Python 包约 27.2 MB 并内含检测、方向分类、识别三个小模型。但它仍需要 Python、ONNX Runtime、OpenCV 等依赖，且官方列出的实现语言不含 Node.js。[安装文档](https://rapidai.github.io/RapidOCRDocs/main/en/install_usage/rapidocr/install/)；[架构与平台](https://rapidai.github.io/RapidOCRDocs/main/en/)
3. **Tesseract 只作为传统基线，不作为首选。** 它成熟、Apache-2.0、支持简体中文语言包，但需要单独安装原生引擎和语言数据；它只做 OCR，不提供面向中国票据的版面、表格或字段抽取能力。[官方安装文档](https://tesseract-ocr.github.io/tessdoc/Installation.html)
4. **允许联网后，安装成本不再是一票否决，但产品承诺必须改。** 当前“零依赖、不联网、安装是纯文件拷贝”与任何本地 OCR 运行时/模型都冲突。新前提允许首次启用时明确下载并缓存，因此可行路线是先做仓库内实验；验证收益后，发布可选 OCR 能力包。安装器必须展示来源与预计下载量、校验哈希、支持代理/重试，并提供升级与卸载，不能把下载藏在第一次报销里。

## 先拆开两个问题

```text
图片字节
  -> OCR：文字检测 + 文字识别
     输出：text + polygon/bbox + confidence
  -> 字段候选提取：材料类型 + 标签/值匹配 + 表格/行程结构
     输出：typed candidates + evidence refs + missing/unreadable
  -> 确定性内核：schema、内容哈希、日期/号码、金额守恒
  -> 用户确认
```

OCR 解决的是“图上有哪些字、字在哪里”。PP-StructureV3 能额外给出通用版面块、阅读顺序和表格单元格，但官方输出仍是版面/OCR/表格结构，不是 `invoice.totalAmount`、`trip.origin` 这类业务字段。[PP-StructureV3 输出说明](https://www.paddleocr.ai/latest/en/version3.x/pipeline_usage/PP-StructureV3.html)

因此字段语义层仍需本项目定义：先识别材料类型，再用坐标邻近、标签词典和票种专用规则产生候选。规则不能找到唯一证据时必须返回 `ambiguous` / `missing`，不能用金额守恒反推出一个“看似正确”的票面值。OCR 分数也只能提示复核优先级，不能把候选升级为事实。

## 决策矩阵

| 维度 | PaddleOCR / PaddleOCR.js | RapidOCR | Tesseract |
|---|---|---|---|
| 中文、中英数字票据 | **强候选。** PP-OCRv5 单模型覆盖简中、繁中、英文、日文；官方列出的 mobile 识别模型为 16 MB，server 为 81 MB。[模型表](https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/module_usage/text_recognition.md) | **强候选。** 默认中英文，模型源于/转换自 PaddleOCR；当前 Python wheel 约 27.2 MB，含三模型。[官方说明](https://rapidai.github.io/RapidOCRDocs/main/en/install_usage/rapidocr/install/) | **可用基线。** 官方提供 `chi_sim`，但通用语言模型不等于票据专项能力。[语言安装](https://tesseract-ocr.github.io/tessdoc/Installation.html) |
| 坐标与置信度 | 行级 `poly`、`text`、`score`，适合证据定位。[SDK 返回值](https://github.com/PaddlePaddle/PaddleOCR/blob/main/paddleocr-js/packages/core/README.md) | 返回文字块、分数和坐标，适合做相同契约的适配器。[快速开始](https://rapidai.github.io/RapidOCRDocs/main/quickstart/) | 可输出 TSV/hOCR 等，但需自行适配；不是结构化字段。 |
| 版面、表格、KIE | PP-StructureV3 支持版面、阅读顺序、表格与 JSON；这会显著增加模型与运行依赖。仍不等于本项目字段 schema。[官方文档](https://www.paddleocr.ai/latest/en/version3.x/pipeline_usage/PP-StructureV3.html) | 核心是 Det -> Cls -> Rec，没有现成报销字段层；可复用其 OCR 输出自行实现。 | 有页面分割，不提供通用表格重建或报销字段 KIE。 |
| macOS / Windows CPU 离线 | Python/C++ 部署链较重；**PaddleOCR.js + WASM + 本地托管模型/wasm** 是最贴近双平台离线的实验路径。官方 SDK 定位是浏览器，不应宣称其 Node API 已受支持。[浏览器部署](https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/inference_deployment/cross_platform/browser.md) | ONNX Runtime CPU 路线现实，但需另装 Python 和一组含原生轮子的依赖；应真机验证公司 macOS/Windows，而不是从“跨平台”宣传推定可发布。 | macOS 可经 Homebrew，Windows 官方页主要指向第三方/构建产物；部署和升级都不是纯文件拷贝。[平台说明](https://tesseract-ocr.github.io/tessdoc/Installation.html) |
| Node 集成 | **三者中最好，但仍非直接。** 官方 `@paddleocr/paddleocr-js` 是浏览器 SDK，依赖 ONNX Runtime Web、OpenCV.js 等；可由本地页面/Worker 调用，不是当前零依赖 Node 内核库。[SDK 架构](https://github.com/PaddlePaddle/PaddleOCR/blob/main/paddleocr-js/docs/architecture.md) | 官方覆盖 Python/C++/Java/C# 等，没有 Node；现实集成是受管本地子进程或本地服务，生命周期与失败协议都要自建。 | Node 通常调用原生命令或非官方 wrapper；需管理可执行文件、语言数据和平台差异。 |
| 体积与安装 | mobile 识别模型 16 MB 只是识别阶段，不含检测模型、SDK、OpenCV.js、WASM。npm 包本身也不是零依赖；模型可指定自托管 URL，首次默认下载行为必须被替换为随包分发。[模型资源规则](https://github.com/PaddlePaddle/PaddleOCR/blob/main/paddleocr-js/packages/core/README.md) | wheel 约 27.2 MB 也不含单独安装的 ONNX Runtime 与其他依赖，不能把它当总安装体积。 | `tessdata_fast` 的 `chi_sim` 与 `eng` 较小，但另有原生引擎和 Leptonica；整体安装仍依赖平台包管理器。[引擎依赖](https://github.com/tesseract-ocr/tesseract) |
| 许可证 | 代码与官方模型 Apache-2.0；分发时仍需保留许可证/NOTICE 并锁定资产哈希。[仓库](https://github.com/PaddlePaddle/PaddleOCR) | 代码 Apache-2.0；当前项目另列模型来源、SHA-256 与再分发要求，便于审计。[模型许可证清单](https://github.com/RapidAI/RapidOCR/blob/main/python/MODEL_LICENSES.md) | 引擎 Apache-2.0，Leptonica 为 BSD-2-Clause；语言数据也应按具体仓库复核。[仓库](https://github.com/tesseract-ocr/tesseract) |
| 维护活跃度（截至研究日） | 活跃：最新正式版 v3.7.0（2026-06-11）。[releases](https://github.com/PaddlePaddle/PaddleOCR/releases) | 活跃：最新正式版 v3.9.2（2026-07-21）。[releases](https://github.com/RapidAI/RapidOCR/releases) | 活跃且成熟：最新正式版 5.5.3（2026-07-24）。[releases](https://github.com/tesseract-ocr/tesseract/releases) |
| 本项目判断 | **首选实验** | **对照实验** | **传统下限基线** |

docTR 未进入矩阵：虽有 OCR、版面、表格和一个名为 KIE 的多类检测管线，但默认预训练识别体系并非面向中文票据，且安装以 Python + PyTorch 为主，部署成本没有补偿性的领域优势。[官方模型与安装说明](https://github.com/mindee/doctr)。Surya 也未进入：当前为 650M 参数 VLM，CPU/Apple Silicon 还要求 `llama.cpp` 服务；代码 Apache-2.0，但模型权重带营收/融资阈值的商业限制，不适合作为本项目默认可再分发依赖。[官方仓库说明](https://github.com/datalab-to/surya)

## 隐私、确定性与证据链

本地推理可以维持“不把材料交给第三方 OCR 服务”的隐私边界，即使安装和模型获取阶段联网。安装流量与材料处理流量必须分开：模型、WASM/原生运行时和字体在启用阶段从固定来源下载、校验并缓存；处理发票时禁止上传图片，每个资产记录版本、许可证和 SHA-256。

OCR 对固定的引擎、模型、参数和硬件通常可重复运行，但它仍是概率识别，不是确定性解析。为了可复核，Skill 产物至少要记录：

- 原图内容哈希与材料 ID；
- 引擎、模型、运行时版本及模型哈希；
- 原始文字、polygon/bbox、识别置信度；
- 字段候选引用的 OCR 行 ID；
- 预处理参数；
- `missing` / `ambiguous`，而不是猜值。

这会改善 ADR-0004 当前“只能相信模型抄写结果”的证据定位，但**不会消除用户确认**。用户仍应能从候选字段跳回原图对应区域。内核继续负责内容哈希、schema、号码/日期规则和金额守恒；OCR/语义提取器都无权写入已确认事实。

## 对 ADR-0004 的影响

若实验成功，ADR-0004 需要新 ADR 明确修订，而不是直接改成“由 OCR 读取”：

- 当前“内核不内置 OCR”可以继续成立；OCR 应是独立能力/适配器，不进入确定性内核。
- 当前“禁止外部识图工具”的理由需要重写。受版本锁定、离线、哈希和证据协议约束的正式 OCR 适配器，与 Agent 临时探测并调用任意 `tesseract` 不是同一件事。
- `source: vision` 应细分为至少 `ocr` 与 `model_vision`，两者都仍是候选；若保留回退路径，还要记录具体引擎。
- `read_images` 的 actor 可从“模型必看图”演进为“提取器先产 OCR 观测，字段层产候选，用户确认”；模型视觉是否作为失败回退，要另做显式决定。
- “零依赖、不联网安装”不再是硬约束，但仍是当前已公开承诺。启用 OCR 必须诚实修改安装、下载量、联网失败、缓存、升级、卸载和支持平台说明；在安装完成后，材料处理仍应保持本地。

## PaddleOCR 集成与分发成本（联网安装前提）

以下比较只覆盖基础通用 OCR（检测 + 识别），不把 PP-StructureV3 或 VLM 的额外模型算入。项目现状是 Node >= 21、Claude Code Skill、目标 macOS + Windows CPU；允许首次启用时联网获取依赖和模型，此后本地处理材料。

| 官方路径 | 官方支持边界与依赖 | Node / Skill 接法 | 成本与风险 | 分发判断 |
|---|---|---|---|---|
| **PaddleOCR.js + 浏览器/WASM** | 官方定位为浏览器 SDK；npm 包依赖 ONNX Runtime Web、OpenCV.js、`js-yaml`、`clipper-lib`，支持主线程或 Worker。模型以 HTTP(S) 获取的未压缩 tar 提供，内含 `inference.onnx` 与 `inference.yml`；SDK 校验模型名，但官方文档没有承诺内容哈希校验。[SDK 文档](https://github.com/PaddlePaddle/PaddleOCR/blob/main/paddleocr-js/packages/core/README.md) | Node 内核启动本地只读页面，由页面/Worker 推理，再把 JSON 写回受 token 保护的 localhost 端点。不要把浏览器 SDK 当作受支持的 Node API 直接 import。 | **中。** 研究日 [npm 包](https://www.npmjs.com/package/@paddleocr/paddleocr-js)元数据中的包自身解包约 23.8 MB，但这不是完整落地体积；还要加传递依赖、WASM/OpenCV 资产、检测与识别模型及缓存。纯 Web 资产没有 Python/编译器依赖，跨平台面最有利；冷启动受 JS/WASM 初始化、模型下载与 session 创建影响。 | **推荐 packaging spike；首选可选能力包。** 最贴近现有 Chrome/Node 架构，且没有本项目自行分发原生可执行文件带来的 ABI/签名负担。 |
| **Python PaddleOCR + PaddlePaddle** | 官方基础安装是先装 PaddlePaddle，再装 `paddleocr`；`paddleocr[all]` 才包含文档解析、理解、翻译与 KIE 等扩展。默认大多数模型通过 PaddlePaddle 引擎运行；3.5 起也可显式选 ONNX Runtime 等引擎，官方建议一个环境只装一种引擎。[安装](https://www.paddleocr.ai/v3.5.0/en/version3.x/installation.html)；[引擎配置](https://www.paddleocr.ai/latest/en/version3.x/inference_deployment/local_inference/inference_engine.html) | Node 用固定 argv 启动受管 Python 子进程，以 stdin/stdout JSON 通信；需要独立用户级 venv、版本锁、健康检查与进程超时。 | **高。** Python、PaddlePaddle wheel、PaddleOCR、图像依赖和模型共同决定包体；官方页面没有给出 macOS + Windows CPU 的完整锁定环境总量，不能引用单个 wheel 代替。原生 wheel 带来 Python ABI、CPU 架构、系统兼容、杀软误报/隔离与企业代理问题；这些是本项目必须实测的分发风险。 | **适合 Apple Silicon 内部受控员工试点，不适合第一版公开跨平台分发。** 当前官方 macOS wheel 不再覆盖 Intel；详见下节。 |
| **官方 C++ 本地部署 / Paddle Inference** | 官方提供 Linux 与 Windows C++ 本地部署；通用 OCR 需要 CMake、OpenCV 4.x、Paddle Inference 与模型，官方 Linux 指南推荐预编译 Paddle Inference，也允许源码编译。文档目录没有 macOS C++ 通用 OCR 路径。[C++ 总览](https://www.paddleocr.ai/latest/en/version3.x/inference_deployment/local_inference/cpp/cpp_local_deployment.html)；[依赖与模型](https://www.paddleocr.ai/latest/en/version3.x/inference_deployment/local_inference/cpp/OCR.html) | 为每个 OS/CPU 构建并签名一个 CLI，Node 以固定 argv 调用并读取 JSON；不能在员工机器现场编译。 | **很高。** 要维护 Windows 二进制及其 DLL、OpenCV、Paddle Inference、模型；macOS 因缺少同等级官方路径还要自行移植和验证。原生 ABI、运行库、代码签名/公证、杀软信誉与架构矩阵都归本项目负责。官方未给完整可再分发产物总量。 | **不推荐当前阶段分发。** 只在 PaddleOCR.js 性能不达标、且业务价值足以承担原生发布工程时重开。 |

高性能推理不是第四条轻量捷径：官方当前只支持 Linux x86-64 + Python 3.8-3.12，Windows 推荐 Docker/WSL，而且首次可能做模型转换/引擎构建并缓存，冷启动更长；不符合本项目 macOS + 原生 Windows CPU 目标。[高性能推理边界](https://www.paddleocr.ai/latest/en/version3.x/inference_deployment/local_inference/high_performance_inference.html)

### macOS Python 路线的阻塞事实

截至 2026-09，不能把“PaddleOCR 支持 Python”写成“所有 Mac 都支持”。官方信息收敛后的边界是：

| 组合 | 官方可确认范围 | 本项目结论 |
|---|---|---|
| PaddleOCR 3.7 Python 包 | PyPI 元数据要求 Python >= 3.8；包本身依赖 PaddleX OCR core 等，但实际推理还要另装所选引擎。[官方 PyPI 元数据](https://pypi.org/project/paddleocr/3.7.0/) | 这只是上层 API 的 Python 下限，不是平台可分发范围。 |
| PaddlePaddle 3.3 CPU | 官方 macOS 专页要求 Python 3.9-3.13、仅 CPU，并明确当前支持 Apple Silicon arm64、不再支持 x86_64；官方 wheel 索引中的 3.3.0 macOS 文件也只有 `macosx_11_0_arm64`，Windows 则有 `win_amd64`。[macOS 安装](https://www.paddlepaddle.org.cn/documentation/docs/en/install/pip/macos-pip_en.html)；[官方 wheel 索引](https://www.paddlepaddle.org.cn/packages/stable/cpu/paddlepaddle/) | **Apple Silicon 可走官方 CPU wheel；Intel Mac 不在当前版本支持面。** 旧索引里存在 3.0.0 Intel wheel，不足以证明当前 PaddleOCR/PaddlePaddle 组合受支持，首批不应靠旧 wheel 拼装。 |
| ONNX Runtime 1.29 CPU | 官方 PyPI 元数据要求 Python >= 3.11；研究日发布文件包含 macOS 14 arm64 与 Windows amd64 wheel，没有 macOS x86_64 wheel。[官方 PyPI 元数据与文件](https://pypi.org/project/onnxruntime/) | **Apple Silicon macOS 14+ 与 Windows x64 有当前 wheel；Intel Mac 仍不能靠当前 ORT wheel 覆盖。** macOS 12/13 是否可通过锁定旧 ORT 安全支持，官方当前页面不能回答，标为未知。 |

PaddleOCR 3.5+ 的 `engine="onnxruntime"` 是正式接口，不是非官方 hack：官方给出了单模块 `TextDetection(model_name="PP-OCRv5_server_det", engine="onnxruntime")` 示例，也允许给 pipeline 的子模块分别配置引擎和 `CPUExecutionProvider` 等参数。[引擎与 pipeline 配置](https://www.paddleocr.ai/latest/en/version3.x/inference_deployment/local_inference/inference_engine.html)

但“能选 ORT”不等于“官方 Paddle 模型无需准备即可全流水线运行”。另一份当前官方文档明确说 PaddleOCR 预训练模型以 Paddle 静态图保存，要使用 ONNX 格式需安装 PaddleX 的 Paddle2ONNX 插件并转换；Windows 转换甚至注明需要 PaddlePaddle dev 版本。[获取 ONNX 模型](https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/inference_deployment/others/obtaining_onnx_models.md) 两份官方说明之间没有交代：`model_name` 示例是否对所有检测/识别模型自动取得官方 ONNX 资产、转换是否发生在用户机器、完整 OCR pipeline 是否能在**未安装 PaddlePaddle**时只靠 `onnxruntime` 工作。因此以下事项均为阻塞性未知，不能写进发布承诺：

- PP-OCRv5 mobile 检测 + 识别的指定版本是否都有官方预转换 ONNX 资产及固定哈希；
- `paddleocr` + `paddlex[ocr-core]` + `onnxruntime`、不安装 `paddlepaddle` 的干净环境能否完整跑通 `PaddleOCR(...).predict()`；
- 若必须自行转换，转换工具是否只在构建机需要，转换产物能否作为能力包在 macOS/Windows 间复用且保持官方许可与数值一致；
- ONNX Runtime 当前 wheel 的 macOS 14 标签是否意味着 macOS 12/13 硬不支持，以及可接受的旧版锁定点。

实现前基于官方支持面的假设是 Apple Silicon、Python 3.11、PaddlePaddle 3.3 CPU；38 张真实材料的首轮性能 spike 已推翻“Paddle 默认”这一部分。PaddleOCR 3.7 的 medium 与 mobile 配置都未达到本项目延迟门槛，而 RapidOCR 3.9.2 PP-OCRv6 small 的批处理通过。首批默认候选因此改为 RapidOCR PP-OCRv6 small；PP-OCRv6 medium 满足 2 GB 内存约束但延迟失败，与 PaddleOCR 一同保留作准确率对照。完整数据见 `ocr-feasibility-38.md`。

这也不等于 ORT 分发已经全面放行：当前只在一台 Apple Silicon 开发机、Python 3.10 上验证性能；Python 3.11 干净机、企业代理、安装中断和处理期零外连仍待验证。Intel Mac 首批明确不支持。

### 推荐分发形态

**先随内部 Skill 分发编译后的 TypeScript 协调器和 Python worker，RapidOCR 运行时保持可选安装。** 安装命令先展示版本、来源、预计大小和缓存目录；用户确认后下载到用户级版本目录并原子切换。报销运行时只读该缓存，缺失或失败时回退模型视觉。

这套形态对三类受众的判断是：

- **内部受控员工：可行。** 先灰度 RapidOCR Python 路径；PaddleOCR 作为精度诊断对照。
- **公开 macOS + Windows 用户：暂不承诺。** 先通过双平台 packaging spike；尤其要验证浏览器安全策略、企业代理、缓存权限、ARM64/x64 和杀软环境。
- **可选能力包：推荐。** 它允许现有 baox 在下载失败或 OCR 未启用时继续使用当前模型视觉/PDF 路径，也让 OCR 包独立升级、回滚和卸载。

许可证方面，PaddleOCR 项目为 Apache-2.0；能力包仍须保存代码、运行时和模型各自的许可证/NOTICE、下载来源与不可变哈希。不能仅凭顶层仓库许可证推定全部 npm 传递依赖都相同。[PaddleOCR 许可证](https://github.com/PaddlePaddle/PaddleOCR/blob/main/LICENSE)

### 必须用 spike 测出的未知数

官方资料不足以给出一个可信的“安装共下载 N MB、峰值内存 N MB”数字。最小 packaging spike 应锁定一个 SDK 与 mobile 检测/识别模型版本，在干净 macOS ARM64、macOS x64（若仍支持）与 Windows x64 上自动记录：

1. npm tarball、全部传递依赖、WASM/OpenCV、检测模型、识别模型分别的下载字节与落盘字节；缓存二次启用是否零下载。
2. 首次下载、冷启动、热启动、单图与 10 图连续处理耗时；峰值 RSS、浏览器 Worker 内存、模型 session 释放后残留。
3. 断点/重试、HTTP 代理、TLS 检查代理、超时、磁盘满、缓存无写权限、哈希不符、半安装后的原子恢复。
4. Chrome/macOS/Windows 的 CPU 与 WebAssembly 支持矩阵；浏览器被企业策略禁用 Worker、WASM SIMD 或本地资源加载时的明确错误。
5. 安装后抓包证明：处理真实图片时图片字节不离开 localhost；模型请求只发生在安装阶段，运行时断网仍可识别。
6. `pnpm licenses list`（或等价锁文件审计）覆盖传递依赖，模型与运行时许可证/NOTICE 随产物落盘；升级可回滚，卸载不留孤儿缓存。

验收门槛建议：三种目标平台安装成功率 100%；下载项全部有固定 HTTPS 来源和 SHA-256；安装中断后旧版本仍可用；热启动零网络；材料处理零外连；卸载后仅保留审计所需的非材料版本记录；准确率门槛继续使用下一节的字段 exact match 与误填率，而不是 OCR 项目的通用 benchmark。

## 最小可决策实验

不要先实现完整 Skill。先用同一固定脚本和同一数据集比较 PaddleOCR、RapidOCR 和现有模型视觉：

1. 使用 `resources/test-images/` 中 38 张获准使用的私有材料建立金标集，覆盖发票、铁路/汽车票、行程单、酒店水单，以及清晰、截图、倾斜、低对比、遮挡；按**字段 exact match**计分，不只看字符准确率。某种图片材料类型至少有 5 张且关键字段零错误，才对该类型默认启用 OCR。
2. 所有引擎只输出统一的 OCR 观测契约：行文字、坐标、置信度、引擎/模型哈希和耗时。字段规则只写一份，避免把更好的后处理误算成 OCR 优势。
3. 首轮字段只测金额、日期、姓名、起点、终点；记录 exact match、误填率、`missing` 率、单图时延、峰值内存、冷启动、完整离线包体。
4. 在一台无 Python/Homebrew/编译器的 macOS 和一台原生 Windows CPU 机器上联网安装；记录全部下载，并验证安装缓存完成后断网运行。未声明来源、大小或缓存位置的隐式下载算失败。
5. 放行门槛应优先约束**误填率**：允许保守地 `missing`，不允许因为字符总体准确率高就接受票面关键字段的自信误读。

实验前的建议假设是：PaddleOCR 会赢在票据能力，RapidOCR 可能赢在成熟 ONNX CPU 路径，现有模型视觉提供准确率与延迟基线。只有真实报销样本能决定准确率，不应把各项目在不同数据集上的公开 benchmark 横向拼成选型结论。
