# baox 状态机：状态清单

设计前提（本轮已定）：模型不选命令、不拼命令，只执行 `baox next` 给出的那一件事。
**状态推进只认内核自己观测得到的事实**，不认模型的自述。

`actor` 三种：`kernel`（跑命令）/ `model`（模型自己动手，看图或问用户）/ `user`（人必须动手）。

## A. 环境（`baox-setup` 域，`next` 照样报，由主会话决定要不要委派子 Agent）

| 状态 | 内核凭什么判定 | actor | 下一步 | 离开条件 |
|---|---|---|---|---|
| `env_node_unsupported` | `process.versions.node` < 21 | user | 告知去装 Node | 重跑判定通过 |
| `env_chrome_down` | CDP `/json/version` 连不上 | kernel | 起专用 Chrome | 端口应答 |
| `env_not_logged_in` | 探针：登录页可见，读不出 `usernametext` | user | 告知在该窗口登录 | 探针读出显示名 |
| `env_identity_unknown` | 页面加载中 / 读不出且无登录表单 | user | 请人看一眼窗口 | 探针给出确定结论 |
| `env_identity_unbound` | 探针 matched，但无 `identity.json` | user | 会话内列表格请用户认 | 写入绑定 |
| `env_identity_mismatched` | 绑定的 account+tenant ≠ 当前登录 | user | 硬阻塞，请换回本人账号 | 换回 / 改绑（走页面） |
| `env_ready` | 以上全过 | — | 进入任务状态 | — |

## B. 任务主干

| 状态 | 内核凭什么判定 | actor | 下一步 | 离开条件 |
|---|---|---|---|---|
| `schema_too_new` | 数据目录 `schemaVersion` > 内核支持 | user | 硬停，提示升级 baox | — |
| `task_none` | 该 sourceKey 无 open 任务 | kernel | `intake` | 任务建立 |
| `inventory_stale` | 材料目录哈希 ≠ 最近一次盘点 | kernel | 重跑 `intake` | 盘点版本刷新 |
| `intake_open_items` | 盘点有 `read_error`/`kind_unrecognized`/`no_text_in_pdf` | user | 逐条说明并请示 | 用户处置或明确忽略 |
| `classify_pending` | 无当前盘点版本的分类结果 | kernel | `classify` | 分类产出 |
| `image_awaiting_reading` | 存在 `image_awaiting_reading` 项 | model | 逐张 `Read` → 提交读数 | 读数被内核收下 |
| `reading_rejected` | `ocr-submit` 判定 `rejected`（守恒/格式不过） | model | 按 `reasons` 重读同一张 | 通过 |
| `reading_stale` | 图片内容哈希变了 | model | 重读该图 | 通过 |
| `reading_awaiting_confirmation` | 有读数未确认 | user | **终端表格**请用户过目 | 用户认可 |
| `reading_disputed` | 用户给的值 ≠ 机器读数 | model | 摆证据链 + 派干净子 Agent 只重读该字段 | 用户对照原件拍板 |
| `duplicate_blocked` | 跨任务查重命中 | user | 停整批，列出命中 | 用户裁决 |
| `events_pending` | 无当前版本的事件划分 | kernel | `events` | 事件产出 |
| `allocation_required` | 合并交通发票，且**各段之和 ≠ 价税合计**（相等则内核自动定案，不进此态） | user | 列出缺口请用户补 | 分毫不差 |
| `allocation_stale` | 发票内容哈希变了 | user | 同上 | 同上 |
| `project_unassigned` | 有事件没有项目号 | model | 按事件用终端多选问（候选≤3 + 其他） | 每个事件有项目号 |
| `catalog_unverified` | 项目/类别未经 ERP 只读核对 | kernel | `catalog` | 全部 `erp_catalog_confirmed` |
| `catalog_mismatch` | ERP 里查无此项目 / 对不上 | user | 请用户改派 | 重新核对通过 |
| `ready_for_erp_write` | 以上全绿 | user | 摊开待写内容，请用户点头 | 用户同意开始写 |
| `handed_off_recover` | `erpWriteState` 非空 | — | `handoff: baox-recover`，并明说状态变化 | — |
| `archived` | 旧格式任务，迁移时标记 | — | 只读可查 | — |

## C. 不变量

1. **幂等**：连续调用 `next` 不改变状态，永远返回"当前该做的那一件事"。
2. **不可跳步**：`stepToken` 不匹配时内核忽略回传、重发当前步骤。
3. **只认事实**：模型说"做完了"不推进状态；推进的依据是文件哈希、落盘的读数、真实的工具结果。
4. **可撤销/不可撤销分级**：`ready_for_erp_write` 之前的确认走会话；越过它的写入和改绑要内核观测得到的事件。
5. **守恒式不让路**：任何算术不平的读数都不进事实链，只会落回开放项。
