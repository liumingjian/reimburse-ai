# baox 状态机：状态清单

> **状态：已修订（2026-09-11）。** 状态清单与判据仍是内核规格。下文「模型不选命令」的前提与 `actor: model` 的模型执行者说法已被[本地报销应用](standalone-app.md)取代：`actor: model` 的步骤改由页面或应用服务端承担；材料盘点改以上传批次为准。

设计前提（本轮已定）：模型不选命令、不拼命令，只执行 `baox next` 给出的那一件事。
**状态推进只认内核自己观测得到的事实**，不认模型的自述。

`actor` 三种：`kernel`（跑命令）/ `model`（模型自己动手，看图或问用户）/ `user`（人必须动手）。

## A. 环境（`baox-setup` 域，`next` 照样报，由主会话决定要不要委派子 Agent）

| 状态 | 内核凭什么判定 | actor | 下一步 | 离开条件 |
|---|---|---|---|---|
| `env_node_unsupported` | `process.versions.node` < 21 | user | 告知去装 Node | 重跑判定通过 |
| `env_chrome_down` | 显式 ego QA 模式下 task space 不可用（保留旧状态名） | user | 配置或恢复 QA task space | task space 可读 |
| `env_not_logged_in` | 探针：登录页可见，读不出 `usernametext` | user | 告知在该窗口登录 | 探针读出显示名 |
| `env_identity_unknown` | 没有 ERP 页面 / 页面加载中 / 浏览器读取能力或权限不足 | kernel / user | 无页面时用系统默认浏览器打开 ERP；读取失败时告知实际原因 | 探针给出确定结论 |
| `env_chromium_required` | 正式系统模式即将写入或恢复，但没有可用的 Chromium CDP 连接 | kernel / user | 内核启动独立 Chromium 页面；用户在其中登录一次 | CDP 页面可用且探针读出确定身份 |
| `env_identity_unbound` | 探针 matched，但无 `identity.json` | user | 会话内列表格请用户认 | 写入绑定 |
| `env_identity_mismatched` | 绑定的 account+tenant ≠ 当前登录 | user | 硬阻塞，请换回本人账号 | 换回 / 改绑（走页面） |
| `env_ready` | 以上全过 | — | 进入任务状态 | — |

## B. 任务主干

| 状态 | 内核凭什么判定 | actor | 下一步 | 离开条件 |
|---|---|---|---|---|
| `schema_too_new` | 数据目录 `schemaVersion` > 内核支持 | user | 硬停，提示升级 baox | — |
| `home_city_required` | 当前员工没有常驻城市记忆，或任务没有城市快照 | user | 首次先展示位置 Adapter 给出的城市级参考并确认；没有参考时填写常驻城市 | 城市按 tenant+account 记忆；任务冻结快照 |
| `task_none` | 该 sourceKey 无 open 任务 | kernel | `intake` | 任务建立 |
| `inventory_stale` | 材料目录哈希 ≠ 最近一次盘点 | kernel | 重跑 `intake` | 盘点版本刷新 |
| `intake_open_items` | 盘点有 `read_error`/`kind_unrecognized`/`no_text_in_pdf` | user | 逐条说明并请示 | 用户处置或明确忽略 |
| `classify_pending` | 无当前盘点版本的分类结果 | kernel | `classify` | 分类产出 |
| `image_awaiting_reading` | 存在 `image_awaiting_reading` 项 | model | 默认逐张 `Read` 使用模型视觉；明确选择 `ocr-assisted` 时交给内部图片提取 Skill，OCR 缺口再逐张视觉兜底 → 提交读数 | 读数被内核收下 |
| `reading_rejected` | `ocr-submit` 判定 `rejected`（守恒/格式不过） | model | 按 `reasons` 重读同一张 | 通过 |
| `reading_stale` | 图片内容哈希变了 | model | 重读该图 | 通过 |
| `reading_awaiting_confirmation` | 有读数未确认，但没有硬阻塞 | kernel | 候选继续进入分类、关联和费用事件，最终放进整单明细确认表 | 整单明细确认时统一确认 |
| `reading_disputed` | 用户给的值 ≠ 机器读数 | model | 摆证据链 + 派干净子 Agent 只重读该字段 | 用户对照原件拍板 |
| `duplicate_blocked` | 跨任务查重命中 | user | 停整批，列出命中 | 用户裁决 |
| `events_pending` | 无当前版本的事件划分 | kernel | `events` | 事件产出 |
| `allocation_required` | 合并交通发票，且**各段之和 ≠ 价税合计**（相等则内核自动定案，不进此态） | user | 列出缺口请用户补 | 分毫不差 |
| `allocation_stale` | 发票内容哈希变了 | user | 同上 | 同上 |
| `project_book_empty` | 当前身份没有可选的已核验个人项目 | user | `projects-page` 维护个人项目簿 | 至少有一个当前可选项目 |
| `project_unassigned` | 有事件没有项目号 | user | 内核发出 `select-task` 个人项目簿页面 | 每个事件有项目号，提交时本人 fresh allowlist 仍通过 |
| `catalog_unverified` | 项目/类别未经 ERP 只读核对 | kernel | `catalog` | 全部 `erp_catalog_confirmed` |
| `catalog_mismatch` | ERP 里查无此项目 / 对不上 | user | 请用户改派 | 重新核对通过 |
| `preparation_package_pending` | 当前材料和选择没有通过校验的交接包 | kernel | `prepare` 生成发票目录、明细和清单 | 当前材料包生成并通过文件校验 |
| `preparation_blocked` | 材料包已生成，但必需字段或证据不充分 | user | 展示文件与逐项缺口 | 缺项解决并重新生成 |
| `preparation_confirmation` | 当前材料包字段充分，尚无匹配的准备确认 | user | 核对明细文档和发票目录 | 当前包获得用户准备确认 |
| `erp_write_pending` | 当前材料包已确认，且没有 ERP 写入 marker | kernel | `erp-write` 自动进入报销系统，导入发票、填写明细并保存 | 严格回读后保存成功，或进入恢复态 |
| `erp_write_complete` | ERP 已保存并通过修改页签、单号、收票和明细严格回读 | — | 完成草稿交接 | — |
| `handed_off_recover` | `erpWriteState` 非空但不是 `saved` | — | `handoff: baox-recover`，并明说状态变化 | — |

> **`archived` 不在这张表里，它是任务状态，不是状态。** 0.9.x 的在途任务在迁移那一刻被标成
> `archived`：本版的读数要带看图凭据和字段来源，而旧读数两样都没有，接着往下走等于让它们
> 绕过这一版最硬的规矩被投影成事实。存档任务不再被认领（同一个材料目录下次是新建任务），
> 因此它永远不产生动作 —— 一个答不出动作的东西留在状态表里只会骗人。它仍然占着自己那些
> 发票（跨任务查重看得见），也仍然可以作废。动过 ERP 的任务**不标**：那条路要留给
> `handed_off_recover`。

## C. 不变量

1. **幂等**：连续调用 `next` 不改变状态，永远返回"当前该做的那一件事"。
2. **不可跳步**：`stepToken` 不匹配时内核忽略回传、重发当前步骤。
3. **只认事实**：模型说"做完了"不推进状态；推进的依据是文件哈希、落盘的读数、真实的工具结果。
4. **阶段隔离**：准备确认只授权当前材料包对应的这一轮自动 ERP 草稿写入；导入后仍必须逐票回读金额、税额、价税合计和收票身份，不能把确认扩展到别的材料或别的单据。
5. **守恒式不让路**：任何算术不平的读数都不进事实链，只会落回开放项。
6. **身份与来源冻结**：员工常驻城市按 `tenant + account` 记忆，任务保存创建时快照；项目选择只接受提交瞬间当前身份的个人项目簿候选。已确认的历史归属可保留展示，但删除后的项目不能用于新的明细归属。
