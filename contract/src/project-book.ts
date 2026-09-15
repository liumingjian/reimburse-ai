import { z } from 'zod';
import { ActionErrorSchema } from './actions';
import { DateTimeSchema } from './primitives';

// 个人项目簿：任务之外的全局数据，按当前报销系统登录身份（tenant + account）分簿（内核 projects.mjs）。
// 页面照内核 project-book-page.mjs：只录项目号，名称只取报销系统核验回读值；没有编辑，同号再次录入即覆盖；
// 过期日不开放（Skill 里固定传 null，一律「永不过期」）。可选判定、状态标签与说明都由服务端给出，页面只显示。
// 文案照内核 projectintake.mjs / projectmaintain.mjs，员工可见的「ERP」一律写作「报销系统」（内核 FORBIDDEN_USER_TERMS）。

export const ProjectBookEntrySchema = z.object({
  number: z.string().min(1),
  // 报销系统回读的项目名称；回读为空时为 null（页面显示「未回读」）。
  name: z.string().min(1).nullable(),
  // null 表示永不过期。原样给出（内核读不出的过期时间也会原样出现，并当作已过期）。
  expiresOn: z.string().min(1).nullable(),
  lastCheckedAt: DateTimeSchema.nullable(),
  // 内核 annotateProjects：安全项目号 + 未过期 + 最近一次核验 confirmed 才可选。
  selectable: z.boolean(),
  // 可选 / 已过期 / 复检未通过 / 项目号不安全（多个原因用「・」连接）。
  statusLabel: z.string().min(1),
  statusNote: z.string().min(1).nullable(),
});
export type ProjectBookEntry = z.infer<typeof ProjectBookEntrySchema>;

// 接口：GET /api/project-book。身份没核对通过时服务端不读项目簿，返回空列表。
export const ProjectBookSchema = z.object({
  projects: z.array(ProjectBookEntrySchema),
});
export type ProjectBook = z.infer<typeof ProjectBookSchema>;

// 维护动作的结果状态（内核 intakeProject / removeProject / purgeInvalidProjects / recheckAll）：
// 录入 admitted / rejected / not_logged_in / identity_mismatch / query_failed；删除 removed / not_found；
// 清理失效 purged / none；复检 done / empty（以及 not_logged_in / identity_mismatch / query_failed）。
export const PROJECT_BOOK_RESULT_STATUSES = [
  'admitted',
  'rejected',
  'not_logged_in',
  'identity_mismatch',
  'query_failed',
  'removed',
  'not_found',
  'purged',
  'none',
  'done',
  'empty',
] as const;
export type ProjectBookResultStatus = (typeof PROJECT_BOOK_RESULT_STATUSES)[number];

// 内核维护页把这些状态当作「完成了」（serve.mjs serveProjectBookPage 的 acceptResult），其余是没做成、要显示原因。
export const PROJECT_BOOK_ACCEPTED_STATUSES: ReadonlySet<ProjectBookResultStatus> = new Set<ProjectBookResultStatus>(['admitted', 'removed', 'purged', 'none', 'done', 'empty']);

// 录入被拒的核验结论：missing 查不到、ambiguous 对上多条、unusable 不可引用、unsafe 项目号含不能安全查询的字符。
export const PROJECT_REJECTION_VERDICTS = ['missing', 'ambiguous', 'unusable', 'unsafe'] as const;

export const ProjectBookResultSchema = z.object({
  status: z.enum(PROJECT_BOOK_RESULT_STATUSES),
  verdict: z.enum(PROJECT_REJECTION_VERDICTS).nullable(),
  // 服务端成句的结果说明，页面原样显示。
  note: z.string().min(1),
  // 动作之后的整份项目簿（没改动时是原簿；身份没核对通过时为空）。
  book: ProjectBookSchema,
});
export type ProjectBookResult = z.infer<typeof ProjectBookResultSchema>;

// 维护动作的 HTTP 响应：服务端处理了请求就是 200 + ProjectBookResult（含 rejected 等没做成的状态）；
// 请求本身失败时是 { error, book? }。
export const ProjectBookFailureSchema = z.object({
  error: ActionErrorSchema,
  book: ProjectBookSchema.optional(),
});
export type ProjectBookFailure = z.infer<typeof ProjectBookFailureSchema>;

// 结果说明文案（照内核 projectintake.mjs / projectmaintain.mjs，「ERP」写作「报销系统」）。服务端与 mock 共用。
export const PROJECT_BOOK_NOTES = {
  unsafe: (number: string) => `项目号 ${JSON.stringify(number)} 含有不能安全查询的字符，没有加入个人项目簿`,
  intakeNotLoggedIn: '没有已核对的报销系统身份，不能向个人项目簿录入项目',
  maintainNotLoggedIn: '没有已核对的报销系统身份，不能修改个人项目簿',
  recheckNotLoggedIn: '没有已核对的报销系统身份，不能复检个人项目簿',
  identityMismatch: '当前报销系统身份已变化，个人项目簿没有改动；请回到原身份后重试',
  intakeQueryFailed: (reason: string) => `报销系统项目核对没有完成（${reason}），个人项目簿没有改动；稍后重试`,
  missing: (number: string) => `项目号 ${number} 在报销系统项目目录里查不到，没有加入个人项目簿；请核对后重新录入`,
  ambiguous: (number: string, count: number | null) => `项目号 ${number} 在报销系统里对上了 ${count ?? '多'} 条记录，没有加入个人项目簿；请核实唯一项目号`,
  unusable: (number: string, name: string | null) => `项目 ${number}「${name ?? '未回读'}」在报销系统里不可引用，没有加入个人项目簿`,
  admitted: (number: string, name: string | null) => `项目 ${number}「${name ?? '未回读'}」已加入个人项目簿，名称取自报销系统回读值；没有设置过期时间`,
  notFound: (number: string) => `个人项目簿里没有项目号 ${number}`,
  removed: (number: string, name: string | null) => `项目 ${number}「${name ?? '未回读'}」已从个人项目簿删除；已选任务中的历史归属不受影响`,
  purgeNone: '当前没有失效项目，一条都没删',
  purged: (count: number) => `已清理 ${count} 条失效项目；合法历史任务中的项目归属不受影响`,
  recheckEmpty: '个人项目簿是空的，没有什么可复检的',
  recheckQueryFailed: (reason: string) => `复检没有完成（${reason}），个人项目簿没有改动`,
  recheckDone: (checked: number, invalid: number) => `复检了 ${checked} 条项目，其中 ${invalid} 条当前不可选；复检不会自动删除项目`,
} as const;

// 页面文案（照内核 project-book-page.mjs）。
export const PROJECT_BOOK_COPY = {
  title: '个人项目簿',
  lead: '项目号从报销系统核验后加入你这个账号的项目簿。失效项目仍会保留，直到你删除它。',
  numberLabel: '项目号',
  intake: '核验并加入',
  remove: '删除',
  recheck: '复检全部',
  purge: '清理全部失效',
  empty: '当前项目簿为空，请录入第一个项目。',
  neverExpires: '永不过期',
  noName: '未回读',
  // 流程门（内核 project_book_empty）：没有可选项目时项目归属页换成维护入口。录入后不自动离开：
  // 报销材料可能归属不同项目，用户录完再点「开始归属」（内核：完成设置并提交后才继续）。
  gateTitle: '先维护个人项目簿',
  gateLead: '录完本次要用的项目，再开始归属。',
  gateContinue: '项目录完了，开始归属',
  gateContinueHint: '至少录入一个可用项目后才能开始归属',
  // 项目归属页就地新增项目：弹层里是同一个项目簿维护面板。
  addProject: '新增项目',
  addDialogDone: '完成',
} as const;

// 公共项目簿（#194，ADR-0018）：与个人项目簿同一形状，管理员在网页里维护，所有账号共用。删除即停用（条目留在簿里，
// 状态「已停用」，不能再选；再次录入即恢复）；每次改动都追加记录。维护接口只对管理员开放（其他账号 403 forbidden）。
// 结果说明沿用 PROJECT_BOOK_NOTES，把「个人项目簿」换成「公共项目簿」；停用有自己的说明。
export const PUBLIC_PROJECT_BOOK_NOTES = {
  deactivated: (number: string, name: string | null) => `项目 ${number}「${name ?? '未回读'}」已在公共项目簿停用，不能再选；已提交任务中的归属不受影响`,
} as const;

export const PUBLIC_PROJECT_BOOK_COPY = {
  title: '公共项目簿',
  lead: '管理员维护、所有账号共用的项目。停用后不能再选，已提交的归属不受影响；每次改动都会留下记录。',
  remove: '停用',
  empty: '公共项目簿是空的，请录入第一个公共项目。',
} as const;

// 项目归属页：提交前项目被停用或删除的明细（projectAssignment.reselect），要重新选择项目。
export const PROJECT_RESELECT_COPY = {
  title: (count: number) => `${count} 条明细原来归入的项目已停用或已删除，请重新选择项目`,
  line: (no: number, number: string, name: string) => `No.${no}：原项目 ${number} ${name}`,
} as const;

// 项目来源标签（项目归属页的项目列表与已归入明细）。
export const PROJECT_SOURCE_LABEL = { personal: '个人', public: '公共' } as const;
