import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXCLUDE_CHOICE } from './pending/answers';
import { invoiceVariantFixtureParser } from './parse/testing/invoice-variants';
import { api, byFileName, sample, type Upload } from './test/api';
import { createTestServer, type TestClient, type TestServer } from './test/harness';

let server: TestServer;
let signedIn: TestClient;
beforeEach(async () => {
  server = await createTestServer({ parser: invoiceVariantFixtureParser() });
  signedIn = await server.signIn('alice');
});
afterEach(() => server.close());
const client = api(() => signedIn);

function source(name: string, prefix: string): Upload {
  return { ...sample(prefix), name };
}

const matchingVariants = () => [source('variant-match.pdf', 'm07'), source('variant-match.jpg', 'm09')];
const conflictingVariants = () => [source('variant-conflict.pdf', 'm07'), source('variant-conflict.jpg', 'm09')];

async function inventoried(files: readonly Upload[]) {
  const { task } = await client.createTask();
  const uploaded = await client.upload(task.taskId, files);
  await client.accepted(await client.act(uploaded, 'start-inventory'));
  return client.settled(task.taskId);
}

describe('cross-format invoice variants', () => {
  it('groups a matching PDF and photo under the PDF while retaining both originals', async () => {
    const snapshot = await inventoried(matchingVariants());

    expect(snapshot.batches[0]?.files.map((file) => [file.fileName, file.status])).toEqual([
      ['variant-match.pdf', 'accepted'],
      ['variant-match.jpg', 'accepted'],
    ]);
    expect(snapshot.materials).toHaveLength(1);
    const pdf = byFileName(snapshot, 'variant-match.pdf');
    expect(pdf).toMatchObject({ mediaType: 'pdf', kind: 'rail_ticket', role: 'primary_voucher', status: 'ok' });
    expect(pdf.variants).toEqual([
      expect.objectContaining({ fileName: 'variant-match.jpg', mediaType: 'image', originalUrl: expect.stringMatching(/^\/api\/tasks\/[^/]+\/files\/[0-9a-f]{64}$/) }),
    ]);
    expect(pdf.originalUrl).toMatch(/^\/api\/tasks\/[^/]+\/files\/[0-9a-f]{64}$/);
    expect((await signedIn.request(pdf.variants[0]!.originalUrl!)).status).toBe(200);
    expect(snapshot.pendingItems).toEqual([]);
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.lines).toHaveLength(1);
    expect(snapshot.inventory.summary).toMatchObject({ materialCount: 1, okCount: 1, voucherCount: 1, openPendingItemCount: 0 });
  });

  it('keeps cross-format disagreements separate and requires an explicit exclusion', async () => {
    const snapshot = await inventoried(conflictingVariants());

    const pdf = byFileName(snapshot, 'variant-conflict.pdf');
    const photo = byFileName(snapshot, 'variant-conflict.jpg');
    expect(snapshot.materials).toHaveLength(2);
    expect(pdf.variants).toEqual([]);
    expect(photo.variants).toEqual([]);
    expect(snapshot.events).toEqual([]);
    expect(snapshot.lines).toEqual([]);
    expect(snapshot.pendingItems).toHaveLength(2);
    expect(snapshot.pendingItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ materialId: pdf.materialId, itemId: `cross_format_conflict.${pdf.materialId}.${photo.materialId}`, title: '「variant-conflict.pdf」与「variant-conflict.jpg」票面内容不一致', choices: [{ key: EXCLUDE_CHOICE, label: '排除这份材料' }] }),
        expect.objectContaining({ materialId: photo.materialId, itemId: `cross_format_conflict.${photo.materialId}.${pdf.materialId}`, title: '「variant-conflict.jpg」与「variant-conflict.pdf」票面内容不一致', choices: [{ key: EXCLUDE_CHOICE, label: '排除这份材料' }] }),
      ]),
    );
    expect(pdf.checkText).toContain('票面内容不一致');
    expect(photo.checkText).toContain('票面内容不一致');

    const excluded = await client.accepted(await client.act(snapshot, 'answer-pending', { itemId: `cross_format_conflict.${photo.materialId}.${pdf.materialId}`, answer: { choice: EXCLUDE_CHOICE } }));
    expect(byFileName(excluded, 'variant-conflict.jpg')).toMatchObject({ status: 'excluded', role: 'excluded' });
    expect(excluded.pendingItems.filter((item) => item.status === 'open')).toEqual([]);
    expect(excluded.events).toHaveLength(1);
    expect(excluded.lines).toHaveLength(1);
  });

  it('uses the preferred PDF claim for cross-task occupancy', async () => {
    const holder = await inventoried(matchingVariants());
    expect(holder.materials).toHaveLength(1);

    const bob = await server.signIn('bob');
    const bobs = api(() => bob);
    const { task } = await bobs.createTask();
    const uploaded = await bobs.upload(task.taskId, [source('variant-match.pdf', 'm07')]);
    await bobs.accepted(await bobs.act(uploaded, 'start-inventory'));
    const blocked = await bobs.settled(task.taskId);

    expect(blocked.blockers).toEqual([
      expect.objectContaining({ kind: 'duplicate_across_tasks', fileName: 'variant-match.pdf', resolver: '要你处理' }),
    ]);
    expect(blocked.pendingItems).toEqual([]);
    expect(blocked.events).toEqual([]);
    expect(blocked.lines).toEqual([]);
  });

  it('keeps the earliest retained variant claim when a later PDF becomes canonical', async () => {
    const { task: aliceTask } = await client.createTask();
    const photo = await client.upload(aliceTask.taskId, [source('variant-match.jpg', 'm09')]);
    await client.accepted(await client.act(photo, 'start-inventory'));
    await client.settled(aliceTask.taskId);

    const bob = await server.signIn('bob');
    const bobs = api(() => bob);
    const { task: bobTask } = await bobs.createTask();
    const bobUpload = await bobs.upload(bobTask.taskId, [source('variant-match.pdf', 'm07')]);
    await bobs.accepted(await bobs.act(bobUpload, 'start-inventory'));
    const initiallyBlocked = await bobs.settled(bobTask.taskId);
    expect(initiallyBlocked.blockers).toEqual([expect.objectContaining({ kind: 'duplicate_across_tasks', fileName: 'variant-match.pdf' })]);

    const laterPdf = await client.upload(aliceTask.taskId, [source('variant-match.pdf', 'm07')]);
    await client.accepted(await client.act(laterPdf, 'start-inventory'));
    const canonical = await client.settled(aliceTask.taskId);
    expect(canonical.materials).toEqual([expect.objectContaining({ fileName: 'variant-match.pdf' })]);
    expect(canonical.blockers).toEqual([]);

    const stillBlocked = await bobs.current(bobTask.taskId);
    expect(stillBlocked.blockers).toEqual([expect.objectContaining({ kind: 'duplicate_across_tasks', fileName: 'variant-match.pdf' })]);
  });
});
