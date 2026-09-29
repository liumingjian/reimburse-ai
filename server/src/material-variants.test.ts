import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXCLUDE_CHOICE } from './pending/answers';
import { invoiceVariantFixtureParser } from './parse/testing/invoice-variants';
import { api, byFileName, sample, type Upload } from './test/api';
import type { TestClient } from './test/harness';
import { scenario, scenarioServer, type ScenarioServer } from './test/scenario';

let server: ScenarioServer;
let signedIn: TestClient;
beforeEach(async () => {
  server = await scenarioServer({ parser: invoiceVariantFixtureParser() });
  signedIn = await server.signIn('alice');
});
afterEach(() => server.close());
const client = api(() => signedIn);

function source(name: string, prefix: string): Upload {
  return { ...sample(prefix), name };
}

const matchingVariants = () => [source('variant-match.pdf', 'm07'), source('variant-match.jpg', 'm09')];
const conflictingVariants = () => [source('variant-conflict.pdf', 'm07'), source('variant-conflict.jpg', 'm09')];

describe('cross-format invoice variants', () => {
  it('groups a matching PDF and photo under the PDF while retaining both originals', async () => {
    const { reached: snapshot } = await scenario(server, signedIn).at('project', { materials: matchingVariants() });

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
    const { reached: snapshot } = await scenario(server, signedIn).at('pending', { materials: conflictingVariants() });

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
    const { reached: holder } = await scenario(server, signedIn).at('project', { materials: matchingVariants() });
    expect(holder.materials).toHaveLength(1);

    const { reached: blocked } = await scenario(server, await server.signIn('bob')).at('inventory', { materials: [source('variant-match.pdf', 'm07')] });

    expect(blocked.blockers).toEqual([
      expect.objectContaining({ kind: 'duplicate_across_tasks', fileName: 'variant-match.pdf', resolver: '要你处理' }),
    ]);
    expect(blocked.pendingItems).toEqual([]);
    expect(blocked.events).toEqual([]);
    expect(blocked.lines).toEqual([]);
  });

  it('keeps the earliest retained variant claim when a later PDF becomes canonical', async () => {
    const alice = await scenario(server, signedIn).at('project', { materials: [source('variant-match.jpg', 'm09')] });

    const bob = await scenario(server, await server.signIn('bob')).at('inventory', { materials: [source('variant-match.pdf', 'm07')] });
    expect(bob.reached.blockers).toEqual([expect.objectContaining({ kind: 'duplicate_across_tasks', fileName: 'variant-match.pdf' })]);

    const laterPdf = await client.upload(alice.task.taskId, [source('variant-match.pdf', 'm07')]);
    await client.accepted(await client.act(laterPdf, 'start-inventory'));
    const canonical = await alice.settled();
    expect(canonical.materials).toEqual([expect.objectContaining({ fileName: 'variant-match.pdf' })]);
    expect(canonical.blockers).toEqual([]);

    const stillBlocked = await bob.snapshot();
    expect(stillBlocked.blockers).toEqual([expect.objectContaining({ kind: 'duplicate_across_tasks', fileName: 'variant-match.pdf' })]);
  });
});
