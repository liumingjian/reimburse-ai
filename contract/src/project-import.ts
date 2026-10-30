import { z } from 'zod';
import { ProjectBookSchema } from './project-book';

export const ProjectImportRowSchema = z.object({
  row: z.number().int().positive(),
  number: z.string(),
  name: z.string(),
  status: z.enum(['add', 'update', 'skip', 'error']),
  previousName: z.string().nullable(),
  note: z.string(),
});
export type ProjectImportRow = z.infer<typeof ProjectImportRowSchema>;
export type ProjectImportSourceRow = Pick<ProjectImportRow, 'row' | 'number' | 'name'> & { error: string | null };

export const ProjectImportPreviewSchema = z.object({
  previewId: z.string(),
  rows: z.array(ProjectImportRowSchema),
});
export type ProjectImportPreview = z.infer<typeof ProjectImportPreviewSchema>;
export const ProjectImportWorkbookSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('choose-sheet'), sheets: z.array(z.string()) }),
  z.object({ kind: z.literal('preview'), sheets: z.array(z.string()), sheet: z.string(), preview: ProjectImportPreviewSchema }),
]);
export type ProjectImportWorkbook = z.infer<typeof ProjectImportWorkbookSchema>;
export const ProjectImportCommitSchema = z.object({
  previewId: z.string().min(1),
  rows: z.array(z.number().int().positive()).min(1),
});
export type ProjectImportCommit = z.infer<typeof ProjectImportCommitSchema>;
export const ProjectImportResultSchema = z.object({ added: z.number().int().nonnegative(), updated: z.number().int().nonnegative(), book: ProjectBookSchema });
export type ProjectImportResult = z.infer<typeof ProjectImportResultSchema>;

export const PROJECT_IMPORT_STALE = '项目簿或权限已变化，或预览已失效。本次未写入，请刷新预览后重新确认。';
export const PROJECT_SERIAL_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function prepareProjectImportRows(rows: readonly ProjectImportSourceRow[]): ProjectImportRow[] {
  const names = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.number) continue;
    const group = names.get(row.number) ?? new Set<string>();
    group.add(row.name);
    names.set(row.number, group);
  }
  const seen = new Set<string>();
  return rows.map(row => {
    const base = { row: row.row, number: row.number, name: row.name, previousName: null };
    const error = row.error ?? (!row.number || !row.name ? '项目序号和项目号均为必填项。' : !PROJECT_SERIAL_PATTERN.test(row.number) ? '项目序号仅支持 1 至 64 位字母、数字、下划线和连字符。' : null);
    if ((names.get(row.number)?.size ?? 0) > 1) return { ...base, status: 'error', note: '同一项目序号对应不同项目号，请修正文件。' };
    if (error) return { ...base, status: 'error', note: error };
    if (seen.has(row.number)) return { ...base, status: 'skip', note: '文件内完全重复，已合并。' };
    seen.add(row.number);
    return { ...base, status: 'add', note: '新增项目' };
  });
}

export function classifyProjectImport(rows: readonly ProjectImportRow[], current: readonly { number: string; name: string | null }[], reserved: ReadonlySet<string>, scope: 'personal' | 'public'): ProjectImportRow[] {
  const entries = new Map(current.map(entry => [entry.number, entry]));
  return rows.map(row => {
    if (row.status === 'error' || row.status === 'skip') return row;
    if (reserved.has(row.number)) return { ...row, status: 'skip', note: scope === 'personal' ? '公共项目已占用此序号，可直接使用公共项目。' : '个人项目已占用此序号，请使用转公共项目流程。' };
    const existing = entries.get(row.number);
    if (!existing) return { ...row, status: 'add', previousName: null, note: '新增项目' };
    return existing.name === row.name
      ? { ...row, status: 'skip', previousName: existing.name, note: '已存在相同项目，跳过。' }
      : { ...row, status: 'update', previousName: existing.name, note: '项目号不同，勾选后更新。' };
  });
}
