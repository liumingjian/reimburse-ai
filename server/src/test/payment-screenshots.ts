import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_DIR } from '@baox/fixtures';
import type { TaskSnapshot } from '@baox/contract';
import { writeBlob } from '../data-dir';
import type { ParseOutcome } from '../parse/dispatch';
import type { Upload } from './api';
import type { TestClient, TestServer } from './harness';
import { sha256 } from './parse-presets';

// 支付截图 materials for scenario tests (ADR-0032): distinct PNG bytes, and the outcome the preset parser should give
// them as `payment_screenshot/labelled` read with `values`. Pass `outcomes` to `presetParser`.
export function paymentScreenshots() {
  const base = readFileSync(join(GENERATED_DIR, 'print-pg1.png'));
  const outcomes: Record<string, ParseOutcome> = {};
  const upload = (name: string, values: Record<string, string>): Upload => {
    // Bytes after the PNG's end chunk keep it a valid image and make each file its own content.
    const bytes = Buffer.concat([base, Buffer.from(name)]);
    const candidates = Object.entries(values).map(([key, value]) => ({ key, value, source: 'rule:payment_screenshot/labelled', parserVersion: '1', evidence: 'explicit' as const, refs: [] }));
    outcomes[sha256(bytes)] = { outcome: 'recognised', kind: 'payment_screenshot', layout: 'labelled', parserVersion: '1', kindLabel: '支付截图', candidates, findings: [], missing: [] };
    return { name, bytes, type: 'image/png' };
  };
  return { upload, outcomes };
}

// 支付截图 stored the #331 way, in the `payment_screenshot` table, as tasks from before ADR-0032 hold them: one row per
// file at the next revision, as that upload wrote it. Nothing writes there any more, so tests seed the rows.
export async function seedTableScreenshots(server: TestServer, taskId: string, voucherMaterialId: string, files: readonly File[]): Promise<void> {
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const sha256 = writeBlob(server.dataDir, bytes);
    const task = await server.db.selectFrom('task').select(['revision', 'account_id']).where('task_id', '=', taskId).executeTakeFirstOrThrow();
    const [revision, at] = [task.revision + 1, new Date().toISOString()];
    await server.db.insertInto('blob').values({ sha256, size: bytes.byteLength, mime: file.type, created_at: at }).onConflict((oc) => oc.column('sha256').doNothing()).execute();
    await server.db.insertInto('payment_screenshot').values({ screenshot_id: randomUUID(), task_id: taskId, account_id: task.account_id, voucher_material_id: voucherMaterialId, blob_sha256: sha256, file_name: file.name, revision, created_at: at }).execute();
    await server.db.updateTable('task').set({ revision }).where('task_id', '=', taskId).execute();
  }
}

// 支付截图 from a 住宿 invoice's 待确认项 since ADR-0032: one request, a batch placed with the invoice and a new inventory run.
export function postStayScreenshots(client: TestClient, snapshot: TaskSnapshot, voucherMaterialId: string, files: readonly File[]): Promise<Response> {
  const form = new FormData();
  form.append('voucherMaterialId', voucherMaterialId);
  form.append('stepToken', snapshot.step.stepToken);
  for (const file of files) form.append('files', file);
  return client.request(`/api/tasks/${snapshot.task.taskId}/payment-screenshots`, { method: 'POST', body: form });
}
