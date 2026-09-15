import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inlineExecutor, type ParseExecutor } from './parse/executor';
import { api, byFileName, sample, type Upload } from './test/api';
import { createTestServer, type TestClient, type TestServer } from './test/harness';

// Slice 05 (#184) through `app.request()`: rail e-tickets, a ride-hailing invoice paired with its 高德 itinerary, and
// 逐段分摊 (per-leg allocation) — one candidate line per leg when the itinerary conserves to the cent, an allocation
// 待确认项 when it does not.

let server: TestServer;
let signedIn: TestClient;
beforeEach(async () => {
  server = await createTestServer({ parser: inlineExecutor() });
  signedIn = await server.signIn();
});
afterEach(() => server.close());
const client = api(() => signedIn);

async function inventoried(files: readonly Upload[]) {
  const { task } = await client.createTask();
  const uploaded = await client.upload(task.taskId, files);
  await client.accepted(await client.act(uploaded, 'start-inventory'));
  return client.settled(task.taskId);
}

// The real parser, except that one leg amount of the 高德 itinerary reads differently: its legs no longer conserve.
function skewedItinerary(key: string, value: string): ParseExecutor {
  const inner = inlineExecutor();
  return {
    close: inner.close,
    async parse(input) {
      const outcome = await inner.parse(input);
      if (input.fileName !== sample('m04').name || outcome.outcome !== 'recognised') return outcome;
      return { ...outcome, candidates: outcome.candidates.map((c) => (c.key === key ? { ...c, value } : c)) };
    },
  };
}

describe('rail e-tickets', () => {
  it('m07 and m08 each form one long-distance line: travel date, route, net = fare, tax 0', async () => {
    const snapshot = await inventoried([sample('m07'), sample('m08')]);
    const [outbound, back] = [byFileName(snapshot, sample('m07').name), byFileName(snapshot, sample('m08').name)];
    expect(outbound).toMatchObject({ kind: 'rail_ticket', layout: '12306', kindLabel: '铁路电子客票', categoryLabel: '长途交通', role: 'primary_voucher', status: 'ok' });
    expect(snapshot.pendingItems).toEqual([]);
    expect(snapshot.lines).toEqual([
      expect.objectContaining({ voucherMaterialId: outbound.materialId, invoiceLabel: '发票1', date: '2026-08-09', category: { code: 'long_distance', label: '长途交通' }, route: '杭州东 → 上海虹桥', origin: '杭州东', destination: '上海虹桥', grossAmount: '73.00', netAmount: '73.00', taxAmount: '0.00', maskedNumber: '2631************0731' }),
      expect.objectContaining({ voucherMaterialId: back.materialId, invoiceLabel: '发票2', date: '2026-08-22', route: '上海虹桥 → 杭州东', grossAmount: '73.00' }),
    ]);
    expect(snapshot.events.map((e) => e.summary)).toEqual(['G7522 杭州东 → 上海虹桥', 'G7539 上海虹桥 → 杭州东']);
  });
});

describe('ride-hailing invoice + 高德 itinerary', () => {
  it('a conserving itinerary gives one line per leg; net and tax split by the invoice ratio and conserve', async () => {
    const snapshot = await inventoried([sample('m03'), sample('m04')]);
    const invoice = byFileName(snapshot, sample('m03').name);
    const itinerary = byFileName(snapshot, sample('m04').name);
    expect(itinerary).toMatchObject({ kind: 'ride_itinerary', layout: 'amap', kindLabel: '高德行程单', role: 'reference', status: 'ok', linkedMaterialIds: [invoice.materialId] });
    expect(invoice).toMatchObject({ role: 'primary_voucher', status: 'ok', linkedMaterialIds: [itinerary.materialId] });
    expect(snapshot.pendingItems).toEqual([]);
    expect(snapshot.stage).toBe('inventory');

    expect(snapshot.lines.map((l) => [l.no, l.invoiceLabel, l.date, l.city, l.origin, l.destination, l.route, l.grossAmount, l.netAmount, l.taxAmount])).toEqual([
      [1, '发票1', '2026-08-10', '上海市', '虹桥枢纽', '漕河泾', '虹桥枢纽 → 漕河泾', '26.69', '25.92', '0.77'],
      [2, '发票1', '2026-08-10', '上海市', '漕河泾', '静安寺', '漕河泾 → 静安寺', '20.85', '20.24', '0.61'],
      [3, '发票1', '2026-08-12', '上海市', '静安寺', '张江', '静安寺 → 张江', '21.65', '21.02', '0.63'],
    ]);
    for (const line of snapshot.lines) expect(line).toMatchObject({ voucherMaterialId: invoice.materialId, referenceMaterialIds: [itinerary.materialId], maskedNumber: '2631************7402' });
    expect(new Set(snapshot.lines.map((l) => l.lineId)).size).toBe(3);

    expect(snapshot.events.map((e) => [e.summary, e.evidenceNote, e.grossAmount])).toEqual([
      ['高德 · 虹桥枢纽 → 漕河泾', '打车发票与行程单配对：26.69 + 20.85 + 21.65 = 69.19，按分守恒', '26.69'],
      ['高德 · 漕河泾 → 静安寺', null, '20.85'],
      ['高德 · 静安寺 → 张江', null, '21.65'],
    ]);
    expect(snapshot.inventory.summary).toMatchObject({ materialCount: 2, okCount: 2, voucherCount: 1, referenceCount: 1, openPendingItemCount: 0 });
    expect(snapshot.inventory.ungroupedMaterialIds).toEqual([]);
  });

  it('legs that do not conserve raise one allocation 待确认项 and form no line for that invoice', async () => {
    await server.close();
    server = await createTestServer({ parser: skewedItinerary('segments[2].amount', '21.66') });
    signedIn = await server.signIn();
    const snapshot = await inventoried([sample('m03'), sample('m04'), sample('m07')]);
    const invoice = byFileName(snapshot, sample('m03').name);
    const itinerary = byFileName(snapshot, sample('m04').name);

    expect(snapshot.pendingItems).toEqual([
      {
        itemId: `allocation.${invoice.materialId}`,
        materialId: invoice.materialId,
        title: expect.stringContaining('逐段'),
        why: expect.stringContaining('26.69 + 20.85 + 21.66 = 69.20'),
        kind: 'allocation',
        resolver: '要你处理',
        fields: [],
        choices: [],
        allocation: {
          segments: [
            { index: 1, date: '2026-08-10', route: '虹桥枢纽 → 漕河泾', suggested: '26.69' },
            { index: 2, date: '2026-08-10', route: '漕河泾 → 静安寺', suggested: '20.85' },
            { index: 3, date: '2026-08-12', route: '静安寺 → 张江', suggested: '21.66' },
          ],
          total: '69.19',
          giveUpNote: expect.any(String),
        },
        status: 'open',
        answer: null,
      },
    ]);
    expect(invoice).toMatchObject({ status: 'pending', pendingItemIds: [`allocation.${invoice.materialId}`], linkedMaterialIds: [itinerary.materialId] });
    expect(itinerary).toMatchObject({ role: 'reference', status: 'ok' });
    // Nothing is averaged or apportioned: the invoice has no line until the user gives the per-leg totals (#187).
    expect(snapshot.lines.map((l) => l.voucherMaterialId)).toEqual([byFileName(snapshot, sample('m07').name).materialId]);
    expect(snapshot.stage).toBe('pending');
    expect(snapshot.step.kind).toBe('answer_pending');
  });

  it('an invoice without an itinerary forms one line from its face; an itinerary without its invoice links nothing', async () => {
    const alone = await inventoried([sample('m03')]);
    expect(alone.lines).toEqual([expect.objectContaining({ grossAmount: '69.19', netAmount: '67.18', taxAmount: '2.01', referenceMaterialIds: [], route: null })]);

    await server.close();
    server = await createTestServer({ parser: inlineExecutor() });
    signedIn = await server.signIn();
    const orphan = await inventoried([sample('m04'), sample('m05')]);
    const itinerary = byFileName(orphan, sample('m04').name);
    expect(itinerary).toMatchObject({ role: 'reference', status: 'ok', linkedMaterialIds: [], checkText: expect.stringContaining('没有对上') });
    expect(orphan.lines).toEqual([expect.objectContaining({ grossAmount: '38.40', referenceMaterialIds: [] })]);
    expect(orphan.inventory.ungroupedMaterialIds).toEqual([itinerary.materialId]);
  });
});
