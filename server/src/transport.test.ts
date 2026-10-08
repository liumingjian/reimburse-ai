import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inlineExecutor, type ParseExecutor } from './parse/executor';
import { api, byFileName, sample } from './test/api';
import type { TestClient, TestServerOptions } from './test/harness';
import { presetParser } from './test/parse-presets';
import { scenario, scenarioServer, type ScenarioServer } from './test/scenario';

// Slice 05 (#184) through `app.request()`: rail e-tickets, a ride-hailing invoice paired with its 高德 itinerary, and
// 逐段分摊 (per-leg allocation) — one candidate line per leg when the itinerary conserves to the cent, an allocation
// 待确认项 when it does not. Samples replay their preset parse outcomes; the r2xx regression fixtures parse for real.

let server: ScenarioServer;
let signedIn: TestClient;
async function boot(options: TestServerOptions = {}) {
  server = await scenarioServer(options);
  signedIn = await server.signIn();
}
beforeEach(() => boot());
afterEach(() => server.close());
const client = api(() => signedIn);

async function rebooted(options: TestServerOptions) {
  await server.close();
  await boot(options);
}

// The preset parser, except that one leg amount of the 高德 itinerary reads differently: its legs no longer conserve.
function skewedItinerary(key: string, value: string): ParseExecutor {
  const inner = presetParser();
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
    const { reached: snapshot } = await scenario(server, signedIn).at('project', { materials: ['m07', 'm08'] });
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
    const { reached: snapshot } = await scenario(server, signedIn).at('project', { materials: ['m03', 'm04'] });
    const invoice = byFileName(snapshot, sample('m03').name);
    const itinerary = byFileName(snapshot, sample('m04').name);
    expect(itinerary).toMatchObject({ kind: 'ride_itinerary', layout: 'amap', kindLabel: '高德行程单', role: 'reference', status: 'ok', linkedMaterialIds: [invoice.materialId] });
    expect(invoice).toMatchObject({ role: 'primary_voucher', status: 'ok', linkedMaterialIds: [itinerary.materialId] });
    expect(snapshot.pendingItems).toEqual([]);
    // Clean inventory: the paired invoice no longer waits on category_city_missing (#188), so the task moves on.
    expect(snapshot.stage).toBe('project');

    expect(snapshot.lines.map((l) => [l.no, l.invoiceLabel, l.date, l.city, l.origin, l.destination, l.route, l.grossAmount, l.netAmount, l.taxAmount])).toEqual([
      [1, '发票1', '2026-08-10', '上海市', '虹桥枢纽', '漕河泾', '虹桥枢纽 → 漕河泾', '26.69', '25.92', '0.77'],
      [2, '发票1', '2026-08-10', '上海市', '漕河泾', '静安寺', '漕河泾 → 静安寺', '20.85', '20.24', '0.61'],
      [3, '发票1', '2026-08-12', '上海市', '静安寺', '张江', '静安寺 → 张江', '21.65', '21.02', '0.63'],
    ]);
    // Each leg's printed city (上海市) against the task's home city (杭州): out-of-town city transport (#188 deriveCategory).
    for (const line of snapshot.lines) expect(line).toMatchObject({ voucherMaterialId: invoice.materialId, referenceMaterialIds: [itinerary.materialId], maskedNumber: '2631************7402', category: { code: 'remote_city_transport', label: '外地市内交通' } });
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
    await rebooted({ parser: skewedItinerary('segments[2].amount', '21.66') });
    const { reached: snapshot } = await scenario(server, signedIn).at('pending', { materials: ['m03', 'm04', 'm07'] });
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
        screenshotGroup: null,
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

  describe('answering the allocation item (#187 answers into the #184 split)', () => {
    async function skewed() {
      await rebooted({ parser: skewedItinerary('segments[2].amount', '21.66') });
      const { reached: snapshot } = await scenario(server, signedIn).at('pending', { materials: ['m03', 'm04'] });
      return { snapshot, invoice: byFileName(snapshot, sample('m03').name), itinerary: byFileName(snapshot, sample('m04').name) };
    }

    it('conserving per-leg totals form one line per leg with those amounts, and the task moves on to project', async () => {
      const { snapshot, invoice, itinerary } = await skewed();
      const itemId = `allocation.${invoice.materialId}`;

      // Not conserving (69.20 ≠ 69.19): refused, nothing stored.
      const wrong = await client.act(snapshot, 'answer-pending', { itemId, answer: { amounts: ['26.69', '20.85', '21.66'] } });
      expect(wrong.status).toBe(400);
      expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe('allocation_not_conserved');

      const fresh = await client.current(snapshot.task.taskId);
      const done = await client.accepted(await client.act(fresh, 'answer-pending', { itemId, answer: { amounts: ['30.00', '20.00', '19.19'] } }));
      expect(done.pendingItems).toEqual([]);
      expect(done.lines.map((l) => [l.lineId, l.grossAmount])).toEqual([
        [`line.${invoice.materialId}.1`, '30.00'],
        [`line.${invoice.materialId}.2`, '20.00'],
        [`line.${invoice.materialId}.3`, '19.19'],
      ]);
      for (const line of done.lines) {
        expect(line).toMatchObject({ referenceMaterialIds: [itinerary.materialId], category: { code: 'remote_city_transport' } });
        expect((Math.round(Number(line.netAmount) * 100) + Math.round(Number(line.taxAmount) * 100)) / 100).toBe(Number(line.grossAmount));
      }
      expect(done.events[0]?.evidenceNote).toContain('逐段金额由你确认');
      expect(byFileName(done, sample('m03').name)).toMatchObject({ status: 'ok', role: 'primary_voucher' });
      expect(done.stage).toBe('project');
    });

    it('give-up raises a blocking given_up item; excluding the invoice also excludes its linked itinerary', async () => {
      const { snapshot, invoice, itinerary } = await skewed();
      const gaveUp = await client.accepted(await client.act(snapshot, 'answer-pending', { itemId: `allocation.${invoice.materialId}`, answer: { giveUp: true } }));
      expect(gaveUp.pendingItems.map((i) => [i.itemId, i.kind, i.status])).toEqual([
        [`allocation.${invoice.materialId}`, 'allocation', 'resolved'],
        [`given_up.${invoice.materialId}`, 'given_up', 'open'],
      ]);
      expect(byFileName(gaveUp, sample('m03').name)).toMatchObject({ status: 'pending' });
      expect(gaveUp.lines).toEqual([]);
      expect(gaveUp.stage).toBe('pending');

      const excluded = await client.accepted(await client.act(gaveUp, 'exclude-material', { materialId: invoice.materialId }));
      expect(byFileName(excluded, sample('m03').name).status).toBe('excluded');
      expect(byFileName(excluded, sample('m04').name).status).toBe('excluded');
      expect(excluded.pendingItems).toEqual([]);
      expect(itinerary.linkedMaterialIds).toEqual([invoice.materialId]);
    });
  });

  // #210: what every real ride-hailing invoice looks like — the 交通运输服务 (transport services) parent tax class, not
  // the fine 运输服务 class every fixture used to print. Pairing has to admit it on the same rule that categorises it,
  // or the invoice is recognised, categorised 市内交通 and then silently kept out of the pairing, which leaves it with
  // no city at all. The itinerary's two legs sit in two cities, so the same invoice must also split into one 本地 and
  // one 外地 line rather than blocking on the ambiguity.
  it('a *交通运输服务* invoice pairs too, and legs in two cities give one 本地 and one 外地 line', async () => {
    await rebooted({ parser: inlineExecutor() });
    const { reached: snapshot } = await scenario(server, signedIn).at('project', { materials: ['r206', 'r209'] });
    const invoice = byFileName(snapshot, sample('r206').name);
    const itinerary = byFileName(snapshot, sample('r209').name);
    expect(invoice).toMatchObject({ kind: 'vat_invoice', layout: 'einvoice', role: 'primary_voucher', status: 'ok', categoryLabel: '市内交通', linkedMaterialIds: [itinerary.materialId] });
    expect(itinerary).toMatchObject({ kind: 'ride_itinerary', layout: 'amap', role: 'reference', status: 'ok', linkedMaterialIds: [invoice.materialId] });
    expect(snapshot.pendingItems).toEqual([]);
    expect(snapshot.stage).toBe('project');

    // Each leg carries the city the itinerary printed for it, and is categorised against the task's home city (杭州).
    expect(snapshot.lines.map((l) => [l.date, l.city, l.route, l.grossAmount, l.netAmount, l.taxAmount, l.category.code])).toEqual([
      ['2026-08-16', '杭州市', '城站 → 黄龙', '12.49', '12.13', '0.36', 'local_city_transport'],
      ['2026-08-17', '上海市', '虹桥枢纽 → 漕河泾', '15.00', '14.56', '0.44', 'remote_city_transport'],
    ]);
    for (const line of snapshot.lines) expect(line).toMatchObject({ voucherMaterialId: invoice.materialId, referenceMaterialIds: [itinerary.materialId] });
    // The header slots a real itinerary prints: its label is 申请时间, not the 申请日期 the generated fixtures used.
    const header = Object.fromEntries(itinerary.fields.map((field) => [field.key, field.value]));
    expect(header).toMatchObject({ applyDate: '2026-08-17', segmentCount: '2', itineraryTotal: '27.49' });
  });

  it('an invoice without an itinerary has no expense city and waits on category_city_missing; an itinerary without its invoice links nothing', async () => {
    const { reached: alone } = await scenario(server, signedIn).at('pending', { materials: ['m03'] });
    const invoice = byFileName(alone, sample('m03').name);
    expect(alone.pendingItems.map((item) => item.itemId)).toEqual([`category_city_missing.${invoice.materialId}`]);
    expect(alone.lines).toEqual([]);

    await rebooted({});
    const { reached: orphan } = await scenario(server, signedIn).at('pending', { materials: ['m04', 'm05'] });
    const itinerary = byFileName(orphan, sample('m04').name);
    expect(itinerary).toMatchObject({ role: 'reference', status: 'ok', linkedMaterialIds: [], checkText: expect.stringContaining('没有对上') });
    const m05 = byFileName(orphan, sample('m05').name);
    expect(orphan.pendingItems.map((item) => item.itemId)).toEqual([`category_city_missing.${m05.materialId}`]);
    expect(orphan.lines).toEqual([]);
    expect(orphan.inventory.ungroupedMaterialIds).toEqual([itinerary.materialId, m05.materialId]);
  });
});
