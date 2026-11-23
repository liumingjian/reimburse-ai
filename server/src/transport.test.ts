import type { ReadbackVerdict } from '@baox/erp-executor/protocol';
import { TEST_ERP_ACCOUNT, type Script } from './erp/testing/fake-executor';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inlineExecutor, type ParseExecutor } from './parse/executor';
import type { ParseOutcome } from './parse/dispatch';
import type { ParseDoc } from './parse/doc';
import { parseMaterial } from './parse/material';
import { snapshotReaders } from './parse/snapshot';
import { caseDoc, editedCase } from './parse/testing/snapshot-cases';
import { api, byFileName, sample, type Upload } from './test/api';
import type { TestClient, TestServerOptions } from './test/harness';
import { loadParsePresets, presetParser, sha256 } from './test/parse-presets';
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
    // Clean inventory: the paired invoice no longer waits on ride_itinerary_missing (#188), so the task moves on.
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
        manualKinds: [],
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
      const restored = await client.accepted(await client.act(excluded, 'restore-material', { materialId: invoice.materialId }));
      expect(byFileName(restored, sample('m03').name).status).toBe('pending');
      expect(byFileName(restored, sample('m04').name).status).not.toBe('excluded');
      expect(restored.pendingItems).toContainEqual(expect.objectContaining({ kind: 'given_up', status: 'open' }));
      expect(restored.lines).toEqual([]);
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

  it('an invoice without an itinerary has no expense city and waits on ride_itinerary_missing; an itinerary without its invoice links nothing', async () => {
    const { reached: alone } = await scenario(server, signedIn).at('pending', { materials: ['m03'] });
    const invoice = byFileName(alone, sample('m03').name);
    expect(alone.pendingItems.map((item) => item.itemId)).toEqual([`ride_itinerary_missing.${invoice.materialId}`]);
    expect(alone.lines).toEqual([]);

    await rebooted({});
    const { reached: orphan } = await scenario(server, signedIn).at('pending', { materials: ['m04', 'm05'] });
    const itinerary = byFileName(orphan, sample('m04').name);
    expect(itinerary).toMatchObject({ role: 'reference', status: 'ok', linkedMaterialIds: [], checkText: expect.stringContaining('没有对上') });
    const m05 = byFileName(orphan, sample('m05').name);
    expect(orphan.pendingItems.map((item) => item.itemId)).toEqual([`ride_itinerary_missing.${m05.materialId}`]);
    expect(orphan.lines).toEqual([]);
    expect(orphan.inventory.ungroupedMaterialIds).toEqual([itinerary.materialId, m05.materialId]);
  });
});

// #449, #450: a 滴滴 行程单 goes through the same pairing and per-leg lines as a 高德 one. Its parse outcome is the real
// layout reading a redacted capture of a real 滴滴出行-行程单; the invoice is m03 with its amounts set to that 行程单's
// 合计. Both uploads are fixture bytes with a trailing comment, so only the preset decides what they read as.
async function bootDidi(doc: ParseDoc, amounts: { netAmount: string; taxAmount: string; totalAmount: string }): Promise<{ invoice: Upload; itinerary: Upload }> {
  const invoice: Upload = { ...sample('m03'), name: '滴滴打车_发票.pdf', bytes: Buffer.concat([sample('m03').bytes, Buffer.from(`\n% didi-invoice ${amounts.totalAmount}`)]) };
  const itinerary: Upload = { ...sample('m04'), name: '滴滴出行行程报销单.pdf', bytes: Buffer.concat([sample('m04').bytes, Buffer.from(`\n% didi-itinerary ${amounts.totalAmount}`)]) };
  const m03 = Object.entries(loadParsePresets()).find(([name]) => name.startsWith('m03'))?.[1].outcome;
  if (m03?.outcome !== 'recognised') throw new Error('missing recognised preset for m03');
  const set: Readonly<Record<string, string>> = amounts;
  const invoiceOutcome: ParseOutcome = { ...m03, candidates: m03.candidates.map((c) => (set[c.key] ? { ...c, value: set[c.key] ?? c.value } : c)) };
  const itineraryOutcome = await parseMaterial({ materialId: 'didi-itinerary', fileName: itinerary.name, mime: 'application/pdf', bytes: new Uint8Array() }, snapshotReaders(doc));
  await rebooted({ parser: presetParser({ [sha256(invoice.bytes)]: invoiceOutcome, [sha256(itinerary.bytes)]: itineraryOutcome }) });
  return { invoice, itinerary };
}

// The single-page capture: two legs in 西安, 合计 81.60.
describe('ride-hailing invoice + 滴滴 itinerary', () => {
  const DIDI = 'didi-itinerary-single-page';
  const bootWith = (doc: ParseDoc) => bootDidi(doc, { netAmount: '79.22', taxAmount: '2.38', totalAmount: '81.60' });

  it('pairs with the invoice whose 价税合计 equals its 合计 and gives one line per leg, each with its own city; notes name 滴滴', async () => {
    const uploads = await bootWith(caseDoc(DIDI));
    const { reached: snapshot } = await scenario(server, signedIn).at('project', { materials: [uploads.invoice, uploads.itinerary] });
    const invoice = byFileName(snapshot, uploads.invoice.name);
    const itinerary = byFileName(snapshot, uploads.itinerary.name);
    expect(itinerary).toMatchObject({ kind: 'ride_itinerary', layout: 'didi', kindLabel: '滴滴行程单', role: 'reference', status: 'ok', linkedMaterialIds: [invoice.materialId] });
    expect(invoice).toMatchObject({ role: 'primary_voucher', status: 'ok', linkedMaterialIds: [itinerary.materialId] });
    expect(snapshot.pendingItems).toEqual([]);

    expect(snapshot.lines.map((l) => [l.date, l.city, l.origin, l.destination, l.grossAmount, l.netAmount, l.taxAmount, l.category.code])).toEqual([
      ['2026-07-02', '西安市', '长乐公园-东广场-B2层地下停车场-网约车站', '华清|老街油泼面(环山路北店)', '62.70', '60.87', '1.83', 'remote_city_transport'],
      ['2026-07-03', '西安市', '华清东路|中国石化西安临潼骊山加油站', '临潼区|雨金镇站', '18.90', '18.35', '0.55', 'remote_city_transport'],
    ]);
    for (const line of snapshot.lines) expect(line).toMatchObject({ voucherMaterialId: invoice.materialId, referenceMaterialIds: [itinerary.materialId] });
    expect(snapshot.events.map((e) => [e.summary, e.evidenceNote])).toEqual([
      ['滴滴 · 长乐公园-东广场-B2层地下停车场-网约车站 → 华清|老街油泼面(环山路北店)', '打车发票与行程单配对：62.70 + 18.90 = 81.60，按分守恒'],
      ['滴滴 · 华清东路|中国石化西安临潼骊山加油站 → 临潼区|雨金镇站', null],
    ]);
  });

  it('a third-party 行程单 issued through 滴滴 is named by its carrier, in its display name and in the notes of its lines (#451)', async () => {
    const uploads = await bootWith(editedCase(DIDI, { '滴滴出行-行程单': '第三方网约车服务提供方曹操出行—行程单' }));
    const { reached: snapshot } = await scenario(server, signedIn).at('project', { materials: [uploads.invoice, uploads.itinerary] });
    const invoice = byFileName(snapshot, uploads.invoice.name);
    const itinerary = byFileName(snapshot, uploads.itinerary.name);
    expect(itinerary).toMatchObject({ kind: 'ride_itinerary', layout: 'didi', kindLabel: '曹操出行行程单', role: 'reference', status: 'ok', linkedMaterialIds: [invoice.materialId] });
    expect(snapshot.events.map((e) => e.summary)).toEqual([
      '曹操出行 · 长乐公园-东广场-B2层地下停车场-网约车站 → 华清|老街油泼面(环山路北店)',
      '曹操出行 · 华清东路|中国石化西安临潼骊山加油站 → 临潼区|雨金镇站',
    ]);
  });

  it('a refused 滴滴 行程单 (its legs disagree with 共N笔) is not paired, even though its 合计 matches the invoice', async () => {
    const uploads = await bootWith(editedCase(DIDI, { '· 共2笔行程， 合计81.60元': '· 共3笔行程， 合计81.60元' }));
    const { reached: snapshot } = await scenario(server, signedIn).at('pending', { materials: [uploads.invoice, uploads.itinerary] });
    const invoice = byFileName(snapshot, uploads.invoice.name);
    const itinerary = byFileName(snapshot, uploads.itinerary.name);
    expect(itinerary).toMatchObject({ kind: 'ride_itinerary', layout: 'didi', status: 'pending', linkedMaterialIds: [] });
    expect(invoice).toMatchObject({ linkedMaterialIds: [], pendingItemIds: [`ride_itinerary_missing.${invoice.materialId}`] });
    expect(snapshot.lines).toEqual([]);
  });

  it('a 行程起止日期 printed reversed raises one 待确认项 titled for the undecided year, which names the reversed range', async () => {
    const uploads = await bootWith(editedCase(DIDI, { '· 行程起止日期：2026-07-02 至 2026-07-03': '· 行程起止日期：2026-07-03 至 2026-07-02' }));
    const { reached: snapshot } = await scenario(server, signedIn).at('pending', { materials: [uploads.invoice, uploads.itinerary] });
    const itinerary = byFileName(snapshot, uploads.itinerary.name);
    expect(snapshot.pendingItems.filter((item) => item.materialId === itinerary.materialId)).toEqual([
      expect.objectContaining({
        itemId: `validation_failure.${itinerary.materialId}.segment_year_undecided`,
        title: `「${uploads.itinerary.name}」逐段明细的上车日期定不了年份`,
        why: expect.stringContaining('行程起止日期 2026-07-03 至 2026-07-02 起止颠倒'),
      }),
    ]);
  });
});

// #450: the two-page capture (20 legs, wrapped cells, 北京 and 洛阳, 合计 387.24) pairs with a ride-hailing invoice of that
// 价税合计 (3% 增值税) and gives one line per leg, each with its own date and city: legs are never merged by city or day.
describe('ride-hailing invoice + two-page 滴滴 itinerary', () => {
  const CASE = 'didi-itinerary-two-page-wrapped';

  it('gives one line per leg across both pages, 北京 and 洛阳 legs each with their own city', async () => {
    const { invoice, itinerary } = await bootDidi(caseDoc(CASE), { netAmount: '375.96', taxAmount: '11.28', totalAmount: '387.24' });

    const { reached: snapshot } = await scenario(server, signedIn).at('project', { materials: [invoice, itinerary] });
    const voucher = byFileName(snapshot, invoice.name);
    const reference = byFileName(snapshot, itinerary.name);
    expect(reference).toMatchObject({ kind: 'ride_itinerary', layout: 'didi', status: 'ok', linkedMaterialIds: [voucher.materialId] });
    expect(snapshot.pendingItems).toEqual([]);
    const [BJ, LY] = ['北京市', '洛阳市'];
    expect(snapshot.lines.map((l) => [l.date, l.city, l.grossAmount])).toEqual([
      ['2026-07-17', BJ, '23.30'],
      ['2026-07-17', BJ, '42.70'],
      ['2026-07-18', LY, '18.01'],
      ['2026-07-18', LY, '8.97'],
      ['2026-07-19', LY, '10.03'],
      ['2026-07-19', LY, '8.85'],
      ['2026-07-19', LY, '9.65'],
      ['2026-07-19', LY, '11.01'],
      ['2026-07-20', LY, '15.89'],
      ['2026-08-02', BJ, '30.90'],
      ['2026-08-10', BJ, '46.00'],
      ['2026-08-11', BJ, '15.70'],
      ['2026-08-12', BJ, '14.20'],
      ['2026-08-12', BJ, '16.10'],
      ['2026-08-13', BJ, '51.20'],
      ['2026-08-13', BJ, '19.00'],
      ['2026-09-03', LY, '16.19'],
      ['2026-09-04', LY, '6.99'],
      ['2026-09-05', LY, '6.66'],
      ['2026-09-07', LY, '15.89'],
    ]);
    for (const line of snapshot.lines) expect(line).toMatchObject({ voucherMaterialId: voucher.materialId, referenceMaterialIds: [reference.materialId], category: { code: 'remote_city_transport' } });
  });
});

describe('ride-hailing without a companion itinerary', () => {
  it('requires actual trips, rejects one cent off, and projects every entered trip from one voucher', async () => {
    const { reached: pending } = await scenario(server, signedIn).at('pending', { materials: ['m03'] });
    const itemId = pending.pendingItems[0]!.itemId;
    expect(itemId).toMatch(/^ride_itinerary_missing\./);
    const answer = { choice: 'confirm_none', tripCount: '2', 'segments[0].date': '2026-08-01', 'segments[0].city': '杭州', 'segments[0].origin': '机场', 'segments[0].destination': '酒店', 'segments[0].amount': '30.00', 'segments[1].date': '2026-08-02', 'segments[1].city': '上海', 'segments[1].origin': '酒店', 'segments[1].destination': '车站', 'segments[1].amount': '39.20' };
    expect((await client.act(pending, 'answer-pending', { itemId, answer })).status).toBe(400);
    expect((await client.act(pending, 'answer-pending', { itemId, answer: { ...answer, 'segments[0].city': '' } })).status).toBe(400);
    expect((await client.act(pending, 'answer-pending', { itemId, answer: { ...answer, tripCount: '1', 'segments[2].city': '北京' } })).status).toBe(400);
    const ready = await client.accepted(await client.act(pending, 'answer-pending', { itemId, answer: { ...answer, 'segments[1].amount': '39.19' } }));
    expect(ready.stage).toBe('project');
    expect(ready.lines.map(line => [line.date, line.route, line.grossAmount, line.referenceMaterialIds])).toEqual([
      ['2026-08-01', '机场 → 酒店', '30.00', []], ['2026-08-02', '酒店 → 车站', '39.19', []],
    ]);
    expect(new Set(ready.lines.map(line => line.voucherMaterialId)).size).toBe(1);
    const single = await client.accepted(await client.act(ready, 'answer-pending', { itemId, answer: { choice: 'manual_fill', tripCount: '1', 'segments[0].date': '2026-08-03', 'segments[0].city': '杭州', 'segments[0].origin': '家', 'segments[0].destination': '公司' } }));
    expect(single.lines).toHaveLength(1);
    expect(single.lines[0]).toMatchObject({ grossAmount: '69.19', date: '2026-08-03' });
    const excluded = await client.accepted(await client.act(single, 'answer-pending', { itemId, answer: { choice: 'exclude' } }));
    expect(excluded.lines).toEqual([]);
  });
});

it('feeds the same confirmed trips to print and ERP with one original invoice', async () => {
  let approval: ReadbackVerdict | undefined;
  const erp: Script = async (plan, channel) => {
    await channel.emit({
      type: 'attempt_started', attemptId: 'manual-rides-import', action: 'import',
      preconditions: { targetId: 'erp-page-1', url: plan.erpOrigin, formInstanceId: 'form-1', formMode: 'new', billNo: null, receiptRowCount: 0, detailRowCount: 0 },
      expectedPostconditions: {}, compatibility: plan.compatibility, erpAccount: TEST_ERP_ACCOUNT,
    });
    const values = { 收票单: 'SPD001', 发票号码: '26312000000101557402', 不含税金额: '67.18', 税额: '2.01', 价税合计: '69.19' };
    approval = await channel.emit({
      type: 'readback', stage: 'after_import', readings: {
        formMode: { readable: true, value: 'new' }, billNo: { readable: true, value: null },
        receiptsGrid: { ok: true, columns: Object.keys(values).map(label => ({ label })), rows: [{ kind: 'data', values }] },
        detailGrid: { ok: false, reason: 'Not filled yet' },
      },
    });
    const result = { type: 'result', status: 'unknown', code: 'fixture_stop', message: 'Stopped after reading the approved expense lines.', billNo: null, capture: null } as const;
    await channel.emit(result);
    return result;
  };
  const scene = await scenario(server, signedIn).at('pending', { materials: ['m03'], erp });
  const manual = await scene.accept('answer-pending', { itemId: scene.reached.pendingItems[0]!.itemId, answer: {
    choice: 'manual_fill', tripCount: '2',
    'segments[0].date': '2026-08-03', 'segments[0].city': '杭州', 'segments[0].origin': '机场', 'segments[0].destination': '酒店', 'segments[0].amount': '30.00',
    'segments[1].date': '2026-08-04', 'segments[1].city': '上海', 'segments[1].origin': '酒店', 'segments[1].destination': '车站', 'segments[1].amount': '39.19',
  } });
  const assigned = await scene.accept('submit-project-assignment', { purpose: '实际行程', projects: Object.fromEntries(manual.lines.map(line => [line.lineId, 'P-2307'])) });
  await scene.accept('confirm-review', { digest: assigned.confirmation.digest });
  const printed = await scene.accept('generate-print-sheet', {});
  expect(printed.printSheet.pages).toEqual([expect.objectContaining({ bottom: null })]);
  expect((await scene.run('start-erp-write')).stage).toBe('reconcile');
  expect(server.erp!.runs()[0]?.plan.invoices).toEqual([expect.objectContaining({ fileName: sample('m03').name })]);
  expect(approval).toMatchObject({ ok: true, preview: { lines: [
    { date: '2026-08-03', origin: '机场', destination: '酒店', totalAmount: '30.00', expenseItemCode: 'FY008001' },
    { date: '2026-08-04', origin: '酒店', destination: '车站', totalAmount: '39.19', expenseItemCode: 'FY010002' },
  ] } });
});

it('late itineraries require an explicit decision before replacing manual trips', async () => {
  const { reached: pending } = await scenario(server, signedIn).at('pending', { materials: ['m03'] });
  const manual = await client.accepted(await client.act(pending, 'answer-pending', { itemId: pending.pendingItems[0]!.itemId, answer: { choice: 'manual_fill', tripCount: '1', 'segments[0].date': '2026-08-03', 'segments[0].city': '杭州', 'segments[0].origin': '机场', 'segments[0].destination': '酒店' } }));
  await client.accepted(await client.act(manual, 'reopen-upload'));
  await client.upload(manual.task.taskId, [sample('m04')]);
  const uploaded = await client.current(manual.task.taskId);
  await client.accepted(await client.act(uploaded, 'start-inventory'));
  const late = await client.settled(manual.task.taskId);
  const conflict = late.pendingItems.find(item => item.itemId.startsWith('ride_itinerary_conflict.'))!;
  expect(conflict.status).toBe('open');
  const adopted = await client.accepted(await client.act(late, 'answer-pending', { itemId: conflict.itemId, answer: { choice: 'adopt' } }));
  expect(adopted.lines).toHaveLength(3);
  expect(adopted.lines[0]!.date).toBe('2026-08-10');
});
