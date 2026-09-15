import { z } from 'zod';

// 旧数据导入 (legacy import): the one-time, read-only import of the legacy `~/.baox` into the first admin account
// (ADR-0015, ADR-0018). `GET /api/legacy-import` answers the signed-in account's view; only the account that owns a
// failed run may `POST /api/legacy-import/retry` or `/skip`.
//
// status: none 没有导入（不是首个管理员，或还没运行）；absent 没有旧数据；imported 已导入；failed 旧数据损坏，什么都没导入；
// skipped 用户明确选择不导入。
export const LEGACY_IMPORT_STATUSES = ['none', 'absent', 'imported', 'failed', 'skipped'] as const;

export const LegacyImportProblemSchema = z.object({
  // Path relative to the legacy directory, `/`-separated; never an absolute path.
  file: z.string().min(1),
  reason: z.string().min(1),
});

export const LegacyImportReportSchema = z.object({
  homeCity: z.string().nullable(),
  // 个人项目簿 entries imported.
  projects: z.number().int().nonnegative(),
  // ERP-touched legacy tasks imported as ERP 草稿已交接 / 转人工.
  handedOver: z.number().int().nonnegative(),
  handedOff: z.number().int().nonnegative(),
  // 发票占用 (invoice occupancy) claims imported.
  invoices: z.number().int().nonnegative(),
  // Legacy tasks that never touched ERP: not migrated, their invoices stay free.
  notMigrated: z.array(z.string()),
  problems: z.array(LegacyImportProblemSchema),
});
export type LegacyImportReport = z.infer<typeof LegacyImportReportSchema>;

export const LegacyImportSchema = z.object({
  status: z.enum(LEGACY_IMPORT_STATUSES),
  at: z.string().nullable(),
  report: LegacyImportReportSchema.nullable(),
  canRetry: z.boolean(),
});
export type LegacyImport = z.infer<typeof LegacyImportSchema>;

export const LEGACY_IMPORT_ERRORS = {
  notPending: '旧数据导入已经结束，不能再重试或跳过。',
} as const;
