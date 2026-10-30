import { randomUUID } from 'node:crypto';
import { bodyLimit } from 'hono/body-limit';
import type { Hono } from 'hono';
import { classifyProjectImport, PROJECT_IMPORT_STALE, ProjectImportCommitSchema, type ProjectImportRow } from '@baox/contract';
import { readProjectWorkbook } from '@baox/contract/project-xlsx';
import { accountOf, type AppEnv } from './accounts/http';
import { append, createBookService, personalBooks, readBook, serializeBookMutation, type BookRef } from './books';
import type { Db } from './db/database';

type Preview = { id: string; at: number; rows: ProjectImportRow[]; before: Map<string, string> };

export function mountProjectImportRoutes(app: Hono<AppEnv>, db: Db, now: () => Date, changed: (scope: BookRef['scope'], accountId: string) => Promise<void>) {
  // One pending workbook per account and scope. A new preview invalidates an older tab's confirmation.
  const previews = new Map<string, Preview>();
  const ttl = 30 * 60_000;
  const limit = bodyLimit({ maxSize: 10 * 1024 * 1024, onError: c => c.json({ error: { code: 'invalid_input', message: 'Excel 文件不能超过 10 MB。' } }, 413) });

  async function state(tx: Parameters<typeof readBook>[0], ref: BookRef) {
    const current = await readBook(tx, ref);
    const reserved = ref.scope === 'personal'
      ? new Set((await readBook(tx, { scope: 'public' })).map(entry => entry.number))
      : new Set([...(await personalBooks(tx)).values()].flatMap(book => book.map(entry => entry.number)));
    const fingerprint = (number: string) => JSON.stringify([current.find(entry => entry.number === number) ?? null, reserved.has(number)]);
    return { current, reserved, fingerprint };
  }

  for (const scope of ['personal', 'public'] as const) {
    const path = scope === 'personal' ? '/api/project-book/import' : '/api/public-project-book/import';
    app.post(`${path}/preview`, limit, async c => {
      const account = accountOf(c);
      if (scope === 'public' && account.role !== 'admin') return c.json({ error: { code: 'forbidden', message: '只有管理员可以导入公共项目。' } }, 403);
      const key = `${account.accountId}:${scope}`;
      previews.delete(key);
      const body = await c.req.parseBody();
      const file = body['file'];
      if (!(file instanceof File) || !file.name.toLowerCase().endsWith('.xlsx')) return c.json({ error: { code: 'invalid_input', message: '请选择 .xlsx 文件。' } }, 400);
      const sheet = typeof body['sheet'] === 'string' ? body['sheet'] : undefined;
      let workbook: Awaited<ReturnType<typeof readProjectWorkbook>>;
      try { workbook = await readProjectWorkbook(await file.arrayBuffer(), sheet); }
      catch (error) { return c.json({ error: { code: 'invalid_input', message: error instanceof Error ? error.message : '无法读取 Excel。' } }, 400); }
      if (workbook.kind === 'choose-sheet') return c.json(workbook);
      const ref: BookRef = scope === 'personal' ? { scope, ownerAccountId: account.accountId } : { scope };
      const current = await state(db, ref);
      const rows = classifyProjectImport(workbook.rows, current.current, current.reserved, scope);
      const preview: Preview = { id: randomUUID(), at: now().getTime(), rows, before: new Map(rows.map(row => [row.number, current.fingerprint(row.number)])) };
      for (const [key, pending] of previews) if (now().getTime() - pending.at > ttl) previews.delete(key);
      previews.set(key, preview);
      return c.json({ kind: 'preview', sheets: workbook.sheets, sheet: workbook.sheet, preview: { previewId: preview.id, rows } });
    });

    app.post(`${path}/commit`, async c => {
      const account = accountOf(c);
      if (scope === 'public' && account.role !== 'admin') return c.json({ error: { code: 'forbidden', message: PROJECT_IMPORT_STALE } }, 403);
      const input = ProjectImportCommitSchema.safeParse(await c.req.json().catch(() => null));
      if (!input.success) return c.json({ error: { code: 'invalid_input', message: '请选择要导入的正常行。' } }, 400);
      const key = `${account.accountId}:${scope}`;
      const preview = previews.get(key);
      if (!preview || preview.id !== input.data.previewId || now().getTime() - preview.at > ttl) return c.json({ error: { code: 'stale_import', message: PROJECT_IMPORT_STALE } }, 409);
      const selected = new Set(input.data.rows);
      const rows = preview.rows.filter(row => selected.has(row.row));
      if (rows.length !== selected.size || rows.some(row => row.status !== 'add' && row.status !== 'update')) return c.json({ error: { code: 'invalid_input', message: '只能提交预览中可新增或更新的行。' } }, 400);
      const ref: BookRef = scope === 'personal' ? { scope, ownerAccountId: account.accountId } : { scope };
      const accepted = await serializeBookMutation(db, async tx => {
        // Recheck authorization inside the same transaction as the project facts.
        const actor = await tx.selectFrom('account').select(['role', 'active', 'approved']).where('account_id', '=', account.accountId).executeTakeFirstOrThrow();
        if (previews.get(key) !== preview || !actor.active || !actor.approved || (scope === 'public' && actor.role !== 'admin')) return false;
        const current = await state(tx, ref);
        if (rows.some(row => current.fingerprint(row.number) !== preview.before.get(row.number))) return false;
        await append(tx, ref, account.accountId, now().toISOString().replace(/\.\d{3}Z$/, 'Z'), rows.map(row => ({
          number: row.number, name: row.name,
          ...(row.status === 'add'
            ? { action: 'admitted' as const, admissionSource: 'manual' as const }
            : { action: 'checked' as const, maintenanceAction: 'edited' as const, previousNumber: row.number, deadlineOn: current.current.find(entry => entry.number === row.number)?.deadlineOn ?? null }),
        })));
        return true;
      });
      if (!accepted) return c.json({ error: { code: 'stale_import', message: PROJECT_IMPORT_STALE } }, 409);
      // Keep the preview until a successful commit. A failed transaction can be retried without partial writes.
      if (previews.get(key) === preview) previews.delete(key);
      await changed(scope, account.accountId);
      return c.json({ added: rows.filter(row => row.status === 'add').length, updated: rows.filter(row => row.status === 'update').length, book: await createBookService(db, ref, account.accountId, now).view() });
    });
  }
}
