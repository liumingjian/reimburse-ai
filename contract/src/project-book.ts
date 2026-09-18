import { z } from 'zod';
import { ActionErrorSchema } from './actions';
import { DateTimeSchema } from './primitives';

// 项目簿 (project books) are owned by an application account or shared publicly. New entries are local preparation
// records: entering one makes it available for 项目归属 (project assignment), but does not claim ERP verification.
// Legacy facts retain their older presentation fields so migration never rewrites their business history.

export const ProjectBookEntrySchema = z.object({
  number: z.string().min(1),
  name: z.string().min(1).nullable(),
  expiresOn: z.string().min(1).nullable(),
  // Local intake deliberately returns null. A timestamp here is only a legacy catalog-check record.
  lastCheckedAt: DateTimeSchema.nullable(),
  // Lifecycle state is independent from ERP availability. An active legacy entry can still be unselectable when its
  // former catalog verdict is invalid, while an inactive entry remains visible and reserves its number.
  active: z.boolean(),
  selectable: z.boolean(),
  statusLabel: z.string().min(1),
  statusNote: z.string().min(1).nullable(),
});
export type ProjectBookEntry = z.infer<typeof ProjectBookEntrySchema>;

export const ProjectBookSchema = z.object({
  projects: z.array(ProjectBookEntrySchema),
});
export type ProjectBook = z.infer<typeof ProjectBookSchema>;

// Both book scopes accept the same explicit, offline intake data.
export const ProjectBookIntakeInputSchema = z.object({
  number: z.string(),
  name: z.string(),
});
export type ProjectBookIntakeInput = z.infer<typeof ProjectBookIntakeInputSchema>;

export const ProjectBookLifecycleInputSchema = z.object({
  number: z.string(),
});
export type ProjectBookLifecycleInput = z.infer<typeof ProjectBookLifecycleInputSchema>;

export const PROJECT_BOOK_RESULT_STATUSES = ['admitted', 'deactivated', 'restored', 'rejected'] as const;
export type ProjectBookResultStatus = (typeof PROJECT_BOOK_RESULT_STATUSES)[number];

export const PROJECT_BOOK_ACCEPTED_STATUSES: ReadonlySet<ProjectBookResultStatus> = new Set<ProjectBookResultStatus>(['admitted', 'deactivated', 'restored']);

// `unsafe` is the only machine-readable validation verdict. Duplicate and ownership feedback remains intentionally
// generic so public intake does not disclose another member's personal book.
export const PROJECT_REJECTION_VERDICTS = ['unsafe'] as const;

export const ProjectBookResultSchema = z.object({
  status: z.enum(PROJECT_BOOK_RESULT_STATUSES),
  verdict: z.enum(PROJECT_REJECTION_VERDICTS).nullable(),
  note: z.string().min(1),
  book: ProjectBookSchema,
});
export type ProjectBookResult = z.infer<typeof ProjectBookResultSchema>;

export const ProjectBookFailureSchema = z.object({
  error: ActionErrorSchema,
  book: ProjectBookSchema.optional(),
});
export type ProjectBookFailure = z.infer<typeof ProjectBookFailureSchema>;

// User-facing feedback is shared by the HTTP server and mock adapter. Names and numbers remain in the submitted form
// after every rejected result, so the caller can correct only the offending value.
export const PROJECT_BOOK_NOTES = {
  numberRequired: '请填写项目号。',
  nameRequired: '请填写项目名称。',
  unsafe: (number: string) => `项目号 ${JSON.stringify(number)} 含有不能安全使用的字符，未加入个人项目簿。`,
  duplicate: (number: string) => `项目号 ${number} 已记录在个人项目簿中，未重复加入。`,
  publicReserved: (number: string) => `项目号 ${number} 已记录在公共项目簿中，请在项目归属时使用公共项目。`,
  publicPersonalCollision: (number: string) => `项目号 ${number} 已记录在个人项目簿中，暂不能加入公共项目簿。`,
  admitted: (number: string, name: string) => `项目 ${number}「${name}」已加入个人项目簿，可用于新的项目归属。`,
  deactivated: (number: string) => `项目号 ${number} 已停用，不能用于新的项目归属。`,
  restored: (number: string) => `项目号 ${number} 已恢复，可用于新的项目归属。`,
  notFound: (number: string) => `个人项目簿里没有项目号 ${number}。`,
  alreadyActive: (number: string) => `项目号 ${number} 当前处于启用状态，无需恢复。`,
  alreadyInactive: (number: string) => `项目号 ${number} 已停用。`,
} as const;

export const PROJECT_BOOK_COPY = {
  title: '个人项目簿',
  lead: '录入项目号和项目名称后，可在新的项目归属中选择。提交去报销前仍会核对项目。',
  numberLabel: '项目号',
  nameLabel: '项目名称',
  intake: '加入项目',
  deactivate: '停用',
  restore: '恢复',
  empty: '当前项目簿为空，请录入第一个项目。',
  noName: '未记录名称',
  gateTitle: '先维护个人项目簿',
  gateLead: '录完本次要用的项目，再开始归属。',
  gateContinue: '项目录完了，开始归属',
  gateContinueHint: '至少录入一个可用项目后才能开始归属',
  addProject: '新增项目',
  addDialogDone: '完成',
} as const;

export const PUBLIC_PROJECT_BOOK_COPY = {
  title: '公共项目簿',
  lead: '所有成员都可以查看和使用公共项目。只有管理员可以录入公共项目。',
  empty: '公共项目簿为空。',
} as const;

export const PROJECT_RESELECT_COPY = {
  title: (count: number) => `${count} 条明细原来归入的项目已停用或已删除，请重新选择项目`,
  line: (no: number, number: string, name: string) => `No.${no}：原项目 ${number} ${name}`,
} as const;

export const PROJECT_SOURCE_LABEL = { personal: '个人', public: '公共' } as const;
