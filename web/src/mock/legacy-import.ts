import { LEGACY_IMPORT_ERRORS, type LegacyImport, type LegacyImportOutcome } from '@baox/contract';
import type { MockOptions } from './options';

// 旧数据导入（mock 服务端角色）：只在创建第一个管理员时跑过一次，这里用 `?legacy=` 直接摆出那一次的结果。
// 只有失败的那次能重试或跳过；重试在 mock 里总是成功（当作用户已经把旧数据修好了）。

const REPORT = { homeCity: '杭州', projects: 2, handedOver: 1, handedOff: 2, invoices: 3, notMigrated: ['六月未提交'], problems: [] };
const EMPTY_REPORT = { homeCity: null, projects: 0, handedOver: 0, handedOff: 0, invoices: 0, notMigrated: [], problems: [] };
const AT = '2026-02-01T09:05:00Z';

const IMPORTED: LegacyImport = { status: 'imported', at: AT, report: REPORT, canRetry: false };
const ABSENT: LegacyImport = { status: 'absent', at: AT, report: EMPTY_REPORT, canRetry: false };
const NONE: LegacyImport = { status: 'none', at: null, report: null, canRetry: false };
const FAILED: LegacyImport = {
  status: 'failed',
  at: AT,
  canRetry: true,
  report: {
    ...EMPTY_REPORT,
    problems: [
      { file: 'tasks/2026-05-10-b1b2c3d4e5/invoices.json', reason: '不是合法的 JSON：读到第 1 行就结束了' },
      { file: 'home-cities.json', reason: '不是合法的 JSON' },
    ],
  },
};

const SEEDED: Readonly<Record<string, LegacyImport>> = { failed: FAILED, imported: IMPORTED, absent: ABSENT };

export type LegacyImportFlow = {
  getLegacyImport(): Promise<LegacyImport>;
  retryLegacyImport(): Promise<LegacyImportOutcome>;
  skipLegacyImport(): Promise<LegacyImportOutcome>;
};

export function createLegacyImportFlow(options: MockOptions): LegacyImportFlow {
  let current: LegacyImport = (options.legacy && SEEDED[options.legacy]) ?? NONE;
  // 导入已经结束（或这个账号本来就没有待处理的那一次）：重试与跳过都拒绝，和服务端同一个错误码。
  const refuse = (): LegacyImportOutcome => ({ ok: false, error: { code: 'import_not_pending', message: LEGACY_IMPORT_ERRORS.notPending }, legacyImport: current });
  return {
    getLegacyImport: async () => current,
    async retryLegacyImport() {
      if (!current.canRetry) return refuse();
      current = IMPORTED;
      return { ok: true, legacyImport: current };
    },
    async skipLegacyImport() {
      if (!current.canRetry) return refuse();
      current = { status: 'skipped', at: current.at, report: current.report, canRetry: false };
      return { ok: true, legacyImport: current };
    },
  };
}
