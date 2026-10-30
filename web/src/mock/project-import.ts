import { classifyProjectImport, PROJECT_IMPORT_STALE, type AppAdapter, type ProjectImportOutcome, type ProjectImportWorkbook, type ProjectImportRow } from '@baox/contract';
import type { MockAuth } from './auth';
import type { MockBookState } from './project-book';

export function createMockProjectImport(auth: MockAuth, state: MockBookState, books: Pick<AppAdapter, 'getProjectBook' | 'getPublicProjectBook'>, refresh: () => void): Pick<AppAdapter, 'previewProjectImport' | 'commitProjectImport'> {
  const pending = new Map<string, { id: string; rows: ProjectImportRow[]; fingerprints: Map<string, string> }>();
  const current = (scope: 'personal' | 'public', owner: string) => scope === 'public' ? state.publicProjects : state.personalByAccount.get(owner) ?? [];
  const reserved = (scope: 'personal' | 'public') => new Set((scope === 'personal' ? state.publicProjects : [...state.personalByAccount.values()].flat()).map(entry => entry.number));
  const fingerprint = (scope: 'personal' | 'public', owner: string, number: string) => JSON.stringify([current(scope, owner).find(entry => entry.number === number) ?? null, reserved(scope).has(number)]);
  const failure = (message: string) => ({ ok: false as const, error: { code: 'import_refused', message } });
  return {
    async previewProjectImport(scope, file, sheet): Promise<ProjectImportOutcome<ProjectImportWorkbook>> {
      const actor = auth.account();
      if (!actor || (scope === 'public' && actor.role !== 'admin')) return failure('没有导入此项目簿的权限。');
      const key = `${actor.accountId}:${scope}`;
      pending.delete(key);
      try {
        if (!file.name.toLowerCase().endsWith('.xlsx') || file.size > 10 * 1024 * 1024) return failure('请选择不超过 10 MB 的 .xlsx 文件。');
        const { readProjectWorkbook } = await import('@baox/contract/project-xlsx');
        const workbook = await readProjectWorkbook(await file.arrayBuffer(), sheet);
        if (workbook.kind === 'choose-sheet') return { ok: true, value: workbook };
        const rows = classifyProjectImport(workbook.rows, current(scope, actor.accountId), reserved(scope), scope);
        const previewId = crypto.randomUUID();
        pending.set(key, { id: previewId, rows, fingerprints: new Map(rows.map(row => [row.number, fingerprint(scope, actor.accountId, row.number)])) });
        return { ok: true, value: { kind: 'preview', sheets: workbook.sheets, sheet: workbook.sheet, preview: { previewId, rows } } };
      } catch (error) { return failure(error instanceof Error ? error.message : '无法读取 Excel。'); }
    },
    async commitProjectImport(scope, input) {
      const actor = auth.account();
      if (!actor || (scope === 'public' && actor.role !== 'admin')) return failure(PROJECT_IMPORT_STALE);
      const key = `${actor.accountId}:${scope}`;
      const preview = pending.get(key);
      if (!preview || preview.id !== input.previewId) return failure(PROJECT_IMPORT_STALE);
      const selected = new Set(input.rows);
      const rows = preview.rows.filter(row => selected.has(row.row));
      if (rows.length === 0 || rows.length !== selected.size || rows.some(row => !['add', 'update'].includes(row.status) || fingerprint(scope, actor.accountId, row.number) !== preview.fingerprints.get(row.number))) return failure(PROJECT_IMPORT_STALE);
      const entries = current(scope, actor.accountId).map(entry => ({ ...entry }));
      for (const row of rows) {
        const entry = entries.find(entry => entry.number === row.number);
        if (entry) entry.name = row.name;
        else entries.push({ number: row.number, name: row.name, expiresOn: null, lastCheckedAt: null, lastVerdict: 'local', active: true });
      }
      if (scope === 'public') state.publicProjects = entries;
      else state.personalByAccount.set(actor.accountId, entries);
      pending.delete(key);
      refresh();
      return { ok: true, value: { added: rows.filter(row => row.status === 'add').length, updated: rows.filter(row => row.status === 'update').length, book: await (scope === 'public' ? books.getPublicProjectBook() : books.getProjectBook()) } };
    },
  };
}
