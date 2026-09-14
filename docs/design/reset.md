# 完全重置

用户明确要求重置后，`baox reset` 立即执行，不使用确认页面、确认参数或额外对话。

- 删除所有本地报销任务（包括已存档及动过 ERP 的任务）、身份绑定、常驻城市、流程凭据、日志、缓存和专用 Chrome profile。
- 保留用户自己维护的个人项目簿（个人项目簿，`<数据根目录>/projects/<身份>.json`，见 `kernel/src/projects.mjs:35`）。重置不清空项目簿；项目簿按登录身份分簿，重新登录后按新身份读取对应的簿。
- 现状差距（2026-09-14）：当前实现仍会清空项目簿，须按本规则修改——`kernel/src/reset.mjs:47-53` 删除数据根目录下除运行依赖外的全部内容（含 `projects/`）；应用页面的文案与缓存也按「清空项目簿」写（`packages/app-ui/src/contract/actions.ts:181,184`、`packages/app-ui/src/adapter/store.ts:144-147`、`packages/app-ui/src/contract/adapter.ts:57`，mock 在 `packages/app-ui/src/mock/mock-adapter.ts:110-113`）。
- 默认清理 `~/.baox`、旧平台数据目录及各自的 `.migrating` 副本；保留新根目录，阻止下次启动重新迁入旧数据。显式设置 `BAOX_HOME` 时仅清理该隔离目录及其迁移暂存目录，与启动迁移的作用域一致。
- 保留安装程序和 `runtime/`、`runtimes/`、`ocr-runtime/` 运行依赖。依赖检查的业务输出 `runtime-dependencies.json` 仍删除。
- 关闭 `BAOX_EGO_TASK_SPACE` 指定的 baox 专属空间，不新建空间，不清除共享登录态。旧专用 Chrome 只在 PID 和 profile 路径核对后关闭。
- 保留原始报销材料和 ERP 远端单据；原始材料的工作区副本随任务删除。

先验证目录并关闭专属浏览器，再删除本地信息。浏览器关闭失败时不删除本地信息；文件删除失败时返回 `reset_failed` 和剩余路径。空目录、缺失目录和重复执行均能完成，不因当前目录为空而漏掉旧副本或浏览器空间。

2026-09-10 用户确认的完全重置是既有任务保留规则的显式例外：
[ADR-0007](../adr/0007-cross-task-invoice-history.md) 的作废约束仍适用于报销流程，但不阻止用户删除全部本地历史；
[ADR-0010](../adr/0010-kernel-side-command-guard.md) 的命令守卫允许精确的 `reset` 调用，不要求步骤凭据。
重置不会对 ERP 作撤销，也不会保留审计清单或发票占用记录。
