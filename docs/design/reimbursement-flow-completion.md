# 报销流程补全核对

核对日期：2026-09-09。本文记录事实、用户已确认的边界和待决策项，不表示候选已被采用或真实 QA 已通过。

## 基线

- 本地 main 为 `8b4de28`，当前 origin/main 为 `9a6f0a7`。
- 工作区已有用户改动；实现应基于核实后的最新主线使用独立工作树。
- 项目已安装 PR #96 候选 `1.0.1 / 15d7c37`，不是已发布主线。

## 八项核对

| 项目 | 证据与状态 | 剩余工作 |
| --- | --- | --- |
| home-city-first-run | 两条主线均未实现；PR #91 和多个工作树只是候选 | 接管实现，验证首次确认、按员工持久化、任务取值固定及命令守卫 |
| classified-detail confirmation gate | 主线无实现；`09ca478` 候选在无 selection 时不能完整推导市内交通类别 | 先提供常驻城市并解耦类别推导，再接项目选择前的确认 |
| Variant B | PR #71 已合并的是原型；生产 `project_unassigned` 仍停在 tell_user | 接入类别分组、批量项目投放及覆盖保护；沿用已选定 B 的交互 |
| PR #96 material-association | OPEN、MERGEABLE；已安装；本次相关六文件测试 92/92；无 GitHub CI/review | 真实材料关联 QA、记录 verdict，再决定合并 |
| vision-date-fix | `vision-date-fix-main / d19032a` 已推，无 PR；本次局部测试 4/4 | 适配现有逐段日期模型后重新验证，不能原样合并 |
| 真实材料回归流程（替代 safe fabricated baseline） | 历史隔离套件 241/241；脚本 `62b4820` 最终 review_failed；用户已决定全部采用真实材料 | 建立真实材料预期结果与可重复回归流程，不继续建设纯虚构材料基线 |
| 真实 QA | #96 readiness 记录仍停在四条明细缺项目号；旧指南只到写入边界 | 更新验收矩阵并完成真实全流程 |
| PR / merge / install | #96 未决，日期修复无 PR，后续发布未决 | 对具体提交记录代码检查、真实 QA、合并和安装证据 |

日期补丁在 `vision.mjs:286` 无条件要求顶层 `fields.travelDate`；现有多段行程测试允许日期仅存在于 `segments[].travelDate`。旧补丁会拒收合法逐段输入，也会拒收明确标注日期 unreadable 的输入。

另有完整流程缺口：origin/main 的 `next.mjs:869-880` 在最终确认后返回 done，并明确说明 ERP 写入尚未接入。因此前面交互完成不等于完整报销流完成。

## 已确认边界

- Q1：常驻城市按员工身份记住，新任务沿用；修改只影响新任务，已开始任务保留原值。
- Q2：本轮完成终点包含接通 ERP 写入、草稿保存、保存后回读一致以及草稿交接。
- Q3：本轮开发复现与流程验收全部使用真实材料，替代此前提出的纯虚构 baseline。逐份查看原件并记录预期字段、材料关联和候选明细，再与实际结果核对；没有真实样本覆盖的场景明确记为未验证，不能用虚构样本通过替代真实 QA verdict。运行保留材料原件，区分本地材料回归与会产生 ERP 写入的全流程验收。
- Q4：最终整单确认绑定日期、分摊、常驻城市、项目、费用类别和费用项目；事实变化重新确认，项目选择提交后不再追加分类确认。
- Q5：日期确实不可读时进入待确认项，允许用户补录或排除对应费用事件；保留原始不可读证据，不用开票日期代替行程日期，缺失日期不能直接放行。
- Variant B 已有选型记录，不重新从头选择交互方案。

## 验证顺序

1. 盘点真实材料并逐份核对预期结果，先复现已安装候选的问题，形成可重复的真实材料回归入口。
2. 适配日期修复、核对材料关联，验证合法逐段输入和歧义阻塞。
3. 首次常驻城市 → Variant B → 最终整单确认，验证状态推进及确认失效。
4. 接通 ERP 草稿链路，验证写入结果未知时先对账，不盲目重放。
5. 在用户参与的真实 QA 中记录版本、实际输出和草稿回读，再作 PR、合并及安装发布决定。

## 证据位置

- [PR #96](https://github.com/liumingjian/reimburse-ai/pull/96)、[PR #91](https://github.com/liumingjian/reimburse-ai/pull/91)、[原型 PR #71](https://github.com/liumingjian/reimburse-ai/pull/71)。
- 本机历史记录：`/Users/lmj/.claude/orchestration/reimburse-ai/INBOX/pr96-qa-readiness.md`。
- 基线最终审核：`/Users/lmj/.claude/orchestration/reimburse-ai/INBOX/safe-fabricated-baseline-script-review.md`。
- [当前真机验收清单](../qa/1.0.0-acceptance.md)仍需按本轮目标更新。

## 本轮实施记录

- 独立工作树：`/Users/lmj/repos/reimburse-ai-flow-completion`，分支 `codex/reimbursement-flow-completion`，基于已 fetch 的 `origin/main / 9a6f0a7`。
- PR #96 的三个提交已 cherry-pick 到该工作树继续验证；未合并远端 PR，未替换已安装 Skill。
- 新候选已接入按员工保存常驻城市、任务固定城市、Variant B 工作台、最终整单确认和日期补录/排除。尚未完成这些步骤的用户真实往返验收。
- 逐份查看当前目录 7 份真实材料（5 份 PDF、2 份 PNG），核对为 4 条费用，合计 4413.43 元；原件未修改，已删除的 AA 材料未恢复。
- 新增 `scripts/qa-real-materials.mjs`，直接读取上述真实材料与真实任务读数。候选的金额、日期、凭证和参考材料对应关系回归通过；最终整单确认前的准备状态仍需按当前契约验收。
- 使用真实明细对工作台作 Playwright 检查：1440px 与 390px 下均展示 4 条明细，勾选合计 4413.43 元，未归属时禁止提交，无横向溢出或脚本错误。项目目录查询、覆盖及正式提交尚待登录后的真实验收。
- 全部内核和脚本语法检查、`git diff --check` 通过；没有用虚构测试替代真实验收。
- 用户已提供常驻城市广州并登录。身份核对通过，`next` 实际完成常驻城市保存；真实材料回归覆盖长途交通 1 条、本地市内交通 2 条、住宿 1 条，最终整单确认仍按当前契约执行。
- 历史分类确认记录中发现图片行程读数的终点曾将原件“傍西酒堂”写成“候西酒堂”；该文本差异已在后续图片读取回归中覆盖，最终整单表仍需用户统一核对。
- ERP 创建、上传导入、保存尚未接成生产链路。历史上传契约显示这些票据曾用于保存草稿，继续写入前需只读核对占用。此次未执行 ERP 写入。
## 2026-09-09 真实往返验证补记

- 用户确认图片终点为“傍西酒堂”；分类确认入口原先不能提交纠正，已修复并实际走通纠正、干净上下文独立重读、与用户读数收敛、重新确认。独立重读模板漏写必需的 `version: 1`，已按真实失败修复。
- 用户确认四条分类明细后进入 Variant B，实际提交 4 条项目归属和事由“客户支持”。三个项目号通过当前 ERP 只读目录核对；覆盖保护的用户往返仍未验收。
- `qa-real-materials --classified` 在外部收票核对前通过，且新增图片终点精确断言。该结论仅覆盖材料、金额、关联、日期和分类。
- 使用当前登录会话的 `QueryBusinessInfo` 确认 `ER_ExpReimbursement.FRecInv -> IV_RecInvBase`；后者 `FIVNUMBER` 为发票号码，`FLINKIVNUMBER`/`FLINKBILLTYPE` 为关联编号/类型。
- 按当前四张真实发票精确查询，全部存在收票记录且金额一致，关联编号/类型为空白；按四个收票单号查询费用报销单返回空行。这个结果不能证明没有其他占用，也不能直接推出允许重复导入或复用。
- 新增 `scripts/check-real-erp-receipts.mjs --dir <真实材料目录>`，只读查询并将证据保存在任务目录 `erp-receipt-check.json`。已有记录进入本地历史检查和 `next` 的 blocking open items；后续运行会保留阻塞，不用口头确认消除。
- 当前任务真实状态为 `intake_open_items`，4 个 `erp_receipt_existing`；`qa-real-materials --receipt-blocked` 验证通过。核对脚本尚未接成所有新任务的必经命令，不能宣称生产查重已完成。
- 正在向用户核实此前测试报销单的实际处置；复用路径、完整创建/导入/保存/回读链路仍未完成。没有执行任何 ERP 写入、远端合并或替换安装。

## 2026-09-09 导入与恢复规则核查

- 用户原话确认旧测试报销单“是的，都已经删除了”。该声明绑定本任务四张发票及当时收票单号，保存为 `erp-receipt-disposition.json`。再次按收票单号查询 `FRecInv.FBillNo` 和 `FRecInvoiceBillNo`，均无关联报销单；声明不会单独清除实时关联冲突。
- 本轮打开未保存新增单，按完整真实流程 QA 授权发起主发票上传；首次外部副作用之前已记录 `upload_dispatched`，参考材料未上传。
- 助手明确拒绝 PDF/PNG 混合上传，队列保持 0。改按类型先传三份 PDF、后传一份 PNG，成功识别四张，合计 4413.43 元。上传后出现多个附件 file input，主发票输入必须按上传入口定位。电脑端入口需要点击链接中的图标；文字不是该入口的可点击元素。
- 助手当前存在新版上传说明弹窗，需读取实际弹窗后关闭“知道了”。勾选四票分别核对实际 checkbox 状态，底部“已选取”数量不能代替勾选证据。
- 本次错误地使用了“选择发票”默认主按钮，实际相当于合并生成。发起一次导入后，ERP 显示四张票均“已存在对应收票单，已进行覆盖”，没有出现需要确认的覆盖弹窗。这个自动覆盖是已经发生的外部副作用，不能描述为只读或未写入。
- 收票回读 4 条、总额 4413.43 元、税额合计 266.15 元；自动生成费用明细 3 条，其中两张市内交通合并为 70.43 元。明细总额虽相等，税额合计只有 264.09 元，且项目与费用项目尚为空。未保存、单号为空。
- 已通过实际下拉菜单确认三个入口及 key：合并 `tbMergeFillEntry`、不合并 `tbMappingFillEntry`、不生成 `tbNotFillEntry`。以后自动化必须显式选择契约规定的“不生成费用明细”，不能调用默认主按钮。当前未重放导入。
- 真实回读发现 `headerField` 把同一逻辑字段的容器和嵌套 `-EDITOR` 误计为两个实例；已只折叠同名父子对，真正多表单实例仍拒绝。当前真实单号正确读为空。
- `erp-reconcile --dir` 新增任务明细条数、逐行金额集合及必填项检查。真实结果从仅总额一致改为明确 `不自洽 / 转人工`。该检查仍不代表所有项目、日期、税额和关联字段的最终保存验收。
- 新增只读 `scripts/qa-real-erp-readback.mjs`，专门复现当前四收票/三明细的真实失败状态。校验新增无单号、两侧总额相等而任务不匹配；通过表示正确阻塞错误结果，不表示完整报销通过。
- 已向用户提出恢复规则变更：允许代理在当前未保存单保留四条收票、不重传、修复为四条费用明细并逐项回读，还是保留现场只修代码。当前恢复 Skill 要求转人工后永远不再修改，规则变更等待用户选择。
- 真实 QA verdict：本地材料关联与分类已通过当前七份材料样本；完整 ERP 流程未通过，当前未保存。PR #96、日期修复及后续安装发布仍未放行。

## 2026-09-09 个人项目簿审计与整合边界

- 用户本轮再次明确业务约束：员工自己维护项目，报销时只能选择本人维护的项目。本节是审计和整合记录，不表示该约束已经进入生产。
- `main=8b4de28`、`origin/main=9a6f0a7` 均未包含个人项目簿实现提交 `20572ce`。主干 `kernel/src/selection.mjs:104-148` 仍接受任意非空项目号并写入 `projectSource: 'user_input_unverified'`；`kernel/src/serve.mjs:39-50,93-136` 仍提供自由项目号输入。已合并的 PR #71（`92b61a75`）只是项目归属交互原型，不是生产实现。
- 候选映射：设计分支 `origin/worktree-personal-project-book`（`7faa6c0`，PR #73 OPEN/DRAFT）只有 CONTEXT/ADR；`origin/worktree-issue-76-project-book`（`2c846c2`，PR #82 OPEN/DRAFT/DIRTY）加入簿存储和只读 `projects`；`origin/worktree-issue-77-maintenance-page`（`17ee086`，Issue #77 CLOSED）和 `origin/worktree-issue-78-selection-book`（`909011d`，Issue #78 CLOSED）分别加入维护页及簿候选限制，但提交目前仅被后续开放 PR 继承；`origin/worktree-issue-79-expiry`（`52168cf`，PR #86 OPEN/DRAFT/DIRTY）加入失效/过期；`origin/worktree-issue-80-book-maintenance`（`4208648`，PR #88 OPEN/DRAFT/DIRTY）加入删除、清理失效和全部复检；`origin/worktree-issue-81-skill-project-book`（`cea2d67`，PR #85 OPEN/DRAFT/DIRTY）接入 Skill，但不含 #79/#80。历史 PR 仍未合并，关闭 Issue 也不等于实现已合并。
- 当前整合以 #80（`4208648`）作为核心移植基线，再接 #81 的 Skill 接线；没有把六个历史分支按顺序盲目 cherry-pick。主窗口 Orchestrator 负责真实 QA，代码委派 `gpt-5.6-luna` max。整合仍在进行，不能写成实现完成或 QA 通过。
- 当前 `codex/reimbursement-flow-completion` 工作台候选通过 `/projects?q=...` 直接查询 ERP 全局有效项目目录（`kernel/src/erpcatalog.mjs:31-40`），不是个人项目簿；其提交路径仍没有把个人簿允许集传入内核校验，任意非空手工项目号仍可能通过。因此该候选尚未满足“只能选本人维护项目”的约束。
- 既有真实 QA 状态保持不变：当前仍为 4 张收票、3 条费用明细且未保存；完整 ERP 流程未通过，不能用本节的分支审计结论替代真实 QA verdict。

## 2026-09-09 恢复审查与当前登录闸

- 主窗口最新实时检查为 ERP `not_logged_in`（`loginFormVisible=true`），因此当前表单是否仍存在、收票和明细条数均未知。上文的“4 张收票、3 条明细、未保存”只能作为 02:08:59 的最后一次历史读数；任务元数据里的 `erpWriteState=upload_dispatched` 保持不动，不能重置。用户重新登录后，第一步必须是单次只读 `erp-reconcile`，再决定是否存在可原地修复的草稿。
- `skills/baox-recover/SKILL.md:16-30,44-88`、`kernel/src/guard.mjs:31-46` 和 `kernel/test/skills.test.mjs:49-54` 将恢复限制为 `erp-reconcile`/`next`，禁止重放导入、重保存和 ERP 点击；`kernel/bin/baox.mjs:353-503` 的 `erp-fill --rehearse` 只写入并回读字段，没有保存；`kernel/src/next.mjs:910-950` 在批准后仍明确写入未接通。因此主窗口已授权的真实 QA 目标（草稿保存、回读、交接）尚未形成生产可执行路径，不能宣称完成。
- 恢复闸门：登录后先确认只有一个可见表单并读取模式、单号、收票行和费用行；不得再次上传/导入。若现有收票仍在，按发票号码与收票单号逐行绑定并原地修复；若收票缺失、表单不存在或实例歧义，保持 `upload_dispatched` 并转人工。个人项目簿当前 CLI 为空，1440/390 UI 检查仅证明无溢出/脚本错误且未录入项目；旧 `selection.json` 的 `user_input_unverified` 项目不能充当本人项目簿证据，不能直接沿用旧项目号。
- 可复用接线：`kernel/src/erpform.mjs` 的 `openSession`、`formTabs`、`readGridByColumn`、`headerField`、`writeHeader`、`writeCell`、`selectOption`、`leaveEdit`、`settleGrid`；`kernel/src/erpreconcile.mjs` 的 `readReconciliation`、`matchTaskLines`、`classifyReconciliation`；`kernel/src/workspace.mjs` 的 `recordErpWrite`/`recordErpAttempt`；以及 `kernel/src/selection.mjs` 的项目簿来源校验。不得把 `scripts/qa-real-erp-readback.mjs` 的硬编码 4/3 断言当作当前状态或保存验证。
- 最小实现建议（待主窗口委派代码）：在 `erpform.mjs` 增加带工具栏读回的明细行新增和保存适配；在 `observe.mjs`/`erpwrite.mjs` 扩充完整 `writePreview`/digest，至少包含 `receiptBindings`（发票号、收票号）、行日期与结束日期、金额/税额、费用项目代码与名称、项目及 `projectSource=erp_catalog_confirmed`、`projectsFrom=project_book`、发票类型和承担部门；在 `baox.mjs`/`next.mjs` 增加用户已授权但明确一次性的修复/保存路径，并在首次保存副作用前记录状态、保存后仅以“新建→修改”和非空单号同时成立才标记已保存。`erpreconcile.mjs` 应作为保存前硬闸，要求 4 行、逐行项目/费用项目/日期/税额/总额与四条收票身份一致。
- 可验证顺序：重新登录 → 单次只读对账 → 重新取得本人项目簿候选并提交选择 → 确认四条明细存在（必要时新增一行）→ 逐字段写入并非编辑态回读 → 对账硬闸通过后只点击一次保存 → 读取新单号和表单模式并完整回读 → 交接给只读恢复/人工决定后续提交。任何保存结果未知都只能再次只读对账，不能重试导入或保存。
