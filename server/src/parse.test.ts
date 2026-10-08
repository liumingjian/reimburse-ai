import { ActionFailureSchema } from '@baox/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inlineExecutor, type ParseExecutor } from './parse/executor';
import { einvoice, QR_SOURCE } from './parse/layouts/einvoice';
import { LAYOUTS } from './parse/layouts';
import { rail12306 } from './parse/layouts/rail12306';
import { api, byFileName, fieldValues, sample, type Upload } from './test/api';
import { createApp } from './app';
import { testClient, type TestClient } from './test/harness';
import { withQr } from './test/qr-pdf';
import { scenario, scenarioServer, type ScenarioServer } from './test/scenario';

// Slice 04 (#183): the background parser job after start-inventory, and the `vat_invoice/einvoice` layout, through
// `app.request()`. Samples (m01–m12) replay their preset parse outcomes, which test/parse-presets.test.ts holds to
// the real parser; a test on regression fixtures (r*) or altered bytes parses for real with `useParser`.

let server: ScenarioServer;
let signedIn: TestClient;
beforeEach(async () => {
  server = await scenarioServer();
  signedIn = await server.signIn();
});
afterEach(() => server.close());
const client = api(() => signedIn);

async function useParser(parser: ParseExecutor) {
  await server.close();
  server = await scenarioServer({ parser });
  signedIn = await server.signIn();
}

const EINVOICE = 'rule:vat_invoice/einvoice';
const RAIL = 'rule:rail_ticket/12306';
const ITINERARY = 'rule:ride_itinerary/amap';

// The inventoried snapshot of a task with `materials`. These tests are about reading materials, not the 住宿 trio
// (#213): its items are answered with 确认没有.
const inventory = async (stage: 'inventory' | 'pending' | 'project', materials: ReadonlyArray<string | Upload>) =>
  (await scenario(server, signedIn).at(stage, { materials, stayTrio: 'answered' })).reached;

describe('the vat_invoice/einvoice layout on @baox/fixtures', () => {
  it('parses m01, m03, m05 and r201 into their face fields; m06 and m12 stay unrecognised', async () => {
    await useParser(inlineExecutor());
    const snapshot = await inventory('pending', ['m01', 'm03', 'm05', 'm06', 'm12', 'r201']);

    const hotel = byFileName(snapshot, sample('m01').name);
    expect(hotel).toMatchObject({ kind: 'vat_invoice', layout: 'einvoice', role: 'primary_voucher', status: 'ok' });
    expect(fieldValues(hotel, EINVOICE)).toEqual({
      invoiceNumber: '26312000000098127734',
      issueDate: '2026-08-22',
      invoiceType: '专票',
      buyerName: '某某科技（上海）有限公司',
      buyerTaxId: '91310000XXXXXXXX0A',
      sellerName: '上海某某酒店管理有限公司',
      sellerTaxId: '91310000YYYYYYYY0B',
      itemName: '*住宿服务*住宿费',
      netAmount: '3433.96',
      taxAmount: '206.04',
      totalAmount: '3640.00',
    });
    for (const field of hotel.fields) expect(field).toMatchObject({ source: EINVOICE, parserVersion: einvoice.version, evidence: 'explicit' });

    // Parsed in full; alone (no itinerary, so no expense city) it waits on category_city_missing (#188).
    const amap = byFileName(snapshot, sample('m03').name);
    expect(amap).toMatchObject({ kind: 'vat_invoice', layout: 'einvoice', status: 'pending', pendingItemIds: [`category_city_missing.${amap.materialId}`] });
    expect(fieldValues(amap, EINVOICE)).toMatchObject({
      invoiceNumber: '26312000000101557402',
      issueDate: '2026-08-13',
      invoiceType: '普票',
      itemName: '*运输服务*客运服务费',
      netAmount: '67.18',
      taxAmount: '2.01',
      totalAmount: '69.19',
    });

    // The 曹操 (Caocao) invoice carries a negative discount row; totals come from the 合计 row, not the first item.
    const caocao = byFileName(snapshot, sample('m05').name);
    expect(fieldValues(caocao, EINVOICE)).toMatchObject({ invoiceNumber: '26312000000099830115', issueDate: '2026-08-11', netAmount: '37.28', taxAmount: '1.12', totalAmount: '38.40' });

    // A ride-hailing invoice that bundles an unrelated fee row beside its 运输服务 row is still recognised (#201),
    // and its totals come from the 合计 row rather than from the leading item row.
    const bundled = byFileName(snapshot, sample('r201').name);
    expect(bundled).toMatchObject({ kind: 'vat_invoice', layout: 'einvoice', status: 'pending', pendingItemIds: [`category_city_missing.${bundled.materialId}`] });
    expect(fieldValues(bundled, EINVOICE)).toMatchObject({
      invoiceNumber: '26312000000104412880',
      issueDate: '2026-08-16',
      invoiceType: '普票',
      sellerName: '某某出行服务（上海）有限公司',
      itemName: '*运输服务*客运服务费',
      netAmount: '47.38',
      taxAmount: '1.60',
      totalAmount: '48.98',
    });

    // No v1 layout covers the 曹操 itinerary; an office-supplies e-invoice is outside the v1 kinds.
    for (const prefix of ['m06', 'm12']) {
      const material = byFileName(snapshot, sample(prefix).name);
      expect(material).toMatchObject({ kind: null, layout: null, role: 'pending', status: 'pending', fields: [] });
      expect(material.pendingItemIds).toHaveLength(1);
      expect(snapshot.inventory.ungroupedMaterialIds).toContain(material.materialId);
    }
    // m03, m05 and r201 are ride-hailing invoices without itineraries: no expense city, so each waits on category_city_missing (#188).
    expect(snapshot.inventory.summary).toMatchObject({ materialCount: 6, okCount: 1, pendingMaterialCount: 5, voucherCount: 1, openPendingItemCount: 5 });
    // Unrecognised materials leave 待确认项 open: the task moves on to pending items.
    expect(snapshot.stage).toBe('pending');
    expect(snapshot.step.kind).toBe('answer_pending');
  });
});

describe('an e-invoice whose text runs are split', () => {
  // #200: real PDF generators draw a label and its value as separate text runs, and letter-spaced titles glyph by
  // glyph. Both fixtures carry the same face as any other e-invoice, so both must parse the same way.
  it('parses r01 (发票号码 label apart from its digits) and r02 (letter-spaced title) into their face fields', async () => {
    await useParser(inlineExecutor());
    const snapshot = await inventory('project', ['r01', 'r02']);

    const splitNumber = byFileName(snapshot, sample('r01').name);
    // Its only items are the 住宿 trio's (#213), answered by `inventory`.
    expect(splitNumber).toMatchObject({ kind: 'vat_invoice', layout: 'einvoice', kindLabel: '全电发票（专票）', role: 'primary_voucher', status: 'ok' });
    expect(fieldValues(splitNumber, EINVOICE)).toEqual({
      invoiceNumber: '26312000000098127801',
      issueDate: '2026-08-20',
      invoiceType: '专票',
      buyerName: '某某科技（上海）有限公司',
      buyerTaxId: '91310000XXXXXXXX0A',
      sellerName: '上海某某酒店管理有限公司',
      sellerTaxId: '91310000YYYYYYYY0B',
      itemName: '*住宿服务*住宿费',
      netAmount: '528.30',
      taxAmount: '31.70',
      totalAmount: '560.00',
    });

    const spacedTitle = byFileName(snapshot, sample('r02').name);
    expect(spacedTitle).toMatchObject({ kind: 'vat_invoice', layout: 'einvoice', kindLabel: '全电发票（普票）', role: 'primary_voucher', status: 'ok' });
    expect(fieldValues(spacedTitle, EINVOICE)).toEqual({
      invoiceNumber: '26312000000098127802',
      issueDate: '2026-08-21',
      invoiceType: '普票',
      buyerName: '某某科技（上海）有限公司',
      buyerTaxId: '91310000XXXXXXXX0A',
      sellerName: '上海某某酒店管理有限公司',
      sellerTaxId: '91310000YYYYYYYY0B',
      itemName: '*住宿服务*住宿费',
      netAmount: '264.15',
      taxAmount: '15.85',
      totalAmount: '280.00',
    });

    // Evidence still names real text observations, one per contributing run.
    for (const material of [splitNumber, spacedTitle]) {
      for (const field of material.fields) expect(field).toMatchObject({ source: EINVOICE, parserVersion: einvoice.version, evidence: 'explicit' });
    }
    expect(snapshot.inventory.summary).toMatchObject({ materialCount: 2, okCount: 2, pendingMaterialCount: 0, voucherCount: 2, openPendingItemCount: 0 });
  });
});

describe('a 铁路电子客票 face whose text runs are split', () => {
  // #204: a real ticket prints its face as a two-column box, so 票价 shares a row with 购买方 and its label and amount
  // are separate runs, and the trip row carries a fourth cell (the seat). Both real tickets of the QA corpus were
  // recognised and then dropped into manual fill because no anchor had one observation to itself.
  it('parses r204 into its face fields and reaches ok, raising no missing-field 待确认项', async () => {
    await useParser(inlineExecutor());
    const snapshot = await inventory('project', ['r204']);

    const rail = byFileName(snapshot, sample('r204').name);
    expect(rail).toMatchObject({ kind: 'rail_ticket', layout: '12306', kindLabel: '铁路电子客票', categoryLabel: '长途交通', role: 'primary_voucher', status: 'ok', pendingItemIds: [] });
    expect(fieldValues(rail, RAIL)).toEqual({
      invoiceNumber: '26312000000102200758',
      issueDate: '2026-08-23',
      trainNumber: 'G1376',
      departStation: '广州南',
      arriveStation: '长沙南',
      travelDate: '2026-08-23',
      departTime: '09:12',
      seatClass: '二等座',
      passengerName: '林颂宜',
      totalAmount: '314.50',
    });
    for (const field of rail.fields) expect(field).toMatchObject({ source: RAIL, parserVersion: rail12306.version, evidence: 'explicit' });

    expect(snapshot.pendingItems).toEqual([]);
    expect(snapshot.inventory.summary).toMatchObject({ materialCount: 1, okCount: 1, pendingMaterialCount: 0, voucherCount: 1, openPendingItemCount: 0 });
    // The trip forms its own expense event, dated by the 乘车日期 rather than the 开票日期.
    expect(snapshot.events).toEqual([expect.objectContaining({ no: 1, voucherMaterialId: rail.materialId, category: { code: 'long_distance', label: '长途交通' }, date: '2026-08-23', grossAmount: '314.50' })]);
  });
});

describe('an itinerary drawn cell by cell', () => {
  // #205: a real 高德行程单 draws every table cell as its own text block. Its 上车时间 cell wraps between the date and
  // the `HH:MM`, its amounts carry a unit (`26.69元`) or a currency mark (`¥42.50`), and its `共计N单行程` summary is
  // several text runs. The legs must still read, so the trip and its invoice form 费用事件 (expense events).
  it('parses r205 into its legs, and with the m03 invoice forms one expense event per leg', async () => {
    await useParser(inlineExecutor());
    const snapshot = await inventory('project', ['m03', 'r205']);

    const invoice = byFileName(snapshot, sample('m03').name);
    const itinerary = byFileName(snapshot, sample('r205').name);
    expect(itinerary).toMatchObject({ kind: 'ride_itinerary', layout: 'amap', kindLabel: '高德行程单', role: 'reference', status: 'ok', pendingItemIds: [], linkedMaterialIds: [invoice.materialId] });
    expect(fieldValues(itinerary, ITINERARY)).toEqual({
      applyDate: '2026-08-13',
      segmentCount: '2',
      itineraryTotal: '69.19',
      'segments[0].date': '2026-08-10',
      'segments[0].time': '08:52',
      'segments[0].carType': '经济型',
      'segments[0].city': '上海市',
      'segments[0].origin': '虹桥枢纽',
      'segments[0].destination': '漕河泾',
      'segments[0].amount': '26.69',
      'segments[1].date': '2026-08-12',
      'segments[1].time': '09:15',
      'segments[1].carType': '经济型',
      'segments[1].city': '上海市',
      'segments[1].origin': '静安寺',
      'segments[1].destination': '张江',
      'segments[1].amount': '42.50',
    });

    // Paired with its invoice, the itinerary no longer leaves anything to answer: one line and one event per leg.
    expect(snapshot.pendingItems).toEqual([]);
    expect(snapshot.lines.map((line) => [line.no, line.date, line.city, line.route, line.grossAmount])).toEqual([
      [1, '2026-08-10', '上海市', '虹桥枢纽 → 漕河泾', '26.69'],
      [2, '2026-08-12', '上海市', '静安寺 → 张江', '42.50'],
    ]);
    expect(snapshot.events.map((event) => [event.summary, event.grossAmount])).toEqual([
      ['高德 · 虹桥枢纽 → 漕河泾', '26.69'],
      ['高德 · 静安寺 → 张江', '42.50'],
    ]);
    expect(snapshot.inventory.summary).toMatchObject({ materialCount: 2, okCount: 2, pendingMaterialCount: 0, voucherCount: 1, referenceCount: 1, openPendingItemCount: 0 });
    expect(snapshot.inventory.ungroupedMaterialIds).toEqual([]);
    expect(snapshot.stage).toBe('project');
  });
});

describe('a whole trip uploaded in one go', () => {
  // #206: the failure this spec exists for showed up only on a real multi-material upload — 材料 18 份 / 通过 0 份 /
  // 主要报销凭证 0 份, every material split into text runs no anchor could match, and nothing in the suite caught it.
  // This is that guard at the highest seam: the split-run fixtures uploaded together the way a trip arrives —
  // invoices, an itinerary and a rail ticket — must produce 费用事件 (expense events), not a queue of 待确认项.
  it('parses every material, forms an expense event per voucher and per leg, and moves past 待确认项', async () => {
    await useParser(inlineExecutor());
    const snapshot = await inventory('project', ['r01', 'r02', 'm03', 'r205', 'r204']);

    const splitNumber = byFileName(snapshot, sample('r01').name);
    const spacedTitle = byFileName(snapshot, sample('r02').name);
    const rideInvoice = byFileName(snapshot, sample('m03').name);
    const itinerary = byFileName(snapshot, sample('r205').name);
    const rail = byFileName(snapshot, sample('r204').name);

    for (const invoice of [splitNumber, spacedTitle]) {
      // Their only items are the 住宿 trio's (#213), answered by `inventory`.
      expect(invoice).toMatchObject({ kind: 'vat_invoice', layout: 'einvoice', categoryLabel: '住宿', role: 'primary_voucher', status: 'ok' });
    }
    expect(rideInvoice).toMatchObject({ kind: 'vat_invoice', layout: 'einvoice', categoryLabel: '市内交通', role: 'primary_voucher', status: 'ok', pendingItemIds: [], linkedMaterialIds: [itinerary.materialId] });
    expect(itinerary).toMatchObject({ kind: 'ride_itinerary', layout: 'amap', role: 'reference', status: 'ok', pendingItemIds: [], linkedMaterialIds: [rideInvoice.materialId] });
    expect(rail).toMatchObject({ kind: 'rail_ticket', layout: '12306', categoryLabel: '长途交通', role: 'primary_voucher', status: 'ok', pendingItemIds: [] });
    expect(fieldValues(rideInvoice, EINVOICE)).toMatchObject({ invoiceNumber: '26312000000101557402', totalAmount: '69.19' });
    expect(fieldValues(rail, RAIL)).toMatchObject({ trainNumber: 'G1376', travelDate: '2026-08-23', totalAmount: '314.50' });

    // Five materials, five events: one per itinerary leg, one per rail trip, one per hotel invoice.
    expect(snapshot.events.map((event) => [event.no, event.voucherMaterialId, event.category.label, event.date, event.grossAmount])).toEqual([
      [1, rideInvoice.materialId, '外地市内交通', '2026-08-10', '26.69'],
      [2, rideInvoice.materialId, '外地市内交通', '2026-08-12', '42.50'],
      [3, rail.materialId, '长途交通', '2026-08-23', '314.50'],
      [4, splitNumber.materialId, '住宿', '2026-08-20', '560.00'],
      [5, spacedTitle.materialId, '住宿', '2026-08-21', '280.00'],
    ]);
    expect(snapshot.lines.map((line) => line.grossAmount)).toEqual(['26.69', '42.50', '314.50', '560.00', '280.00']);

    // The counts a user reads on the inventory page: a silent drop back to 通过 0 份 / 主要报销凭证 0 份 fails here.
    expect(snapshot.inventory.summary).toMatchObject({
      materialCount: 5,
      okCount: 5,
      pendingMaterialCount: 0,
      voucherCount: 4,
      referenceCount: 1,
      openPendingItemCount: 0,
    });
    expect(snapshot.inventory.ungroupedMaterialIds).toEqual([]);
    // The only items are the 住宿 trio's (#213), answered by `inventory`.
    expect(snapshot.pendingItems.filter((item) => !item.itemId.startsWith('stay_'))).toEqual([]);

    // Nothing left to answer, so the task leaves 待确认项 behind and goes on to 项目归属.
    expect(snapshot.stage).toBe('project');
  });
});

describe('the e-invoice QR code, a second evidence source', () => {
  it('a QR that disagrees with the text layer is noted and blocks nothing: the face is the value', async () => {
    await useParser(inlineExecutor());
    const amap = sample('m03');
    const snapshot = await inventory('pending', [{ ...amap, bytes: await withQr(amap.bytes, '01,32,,26312000000101557402,96.19,20260813,,A1B2C3D4') }]);

    const material = byFileName(snapshot, amap.name);
    // `pending` here is the missing expense city below, not the QR: an agreeing QR leaves the material in exactly
    // the same state.
    expect(material).toMatchObject({ kind: 'vat_invoice', layout: 'einvoice' });
    // Both readings stay visible, and the disagreement is in the 校验 column — but the face is what the invoice is
    // worth, and the QR never judges it (ADR-0017, amended).
    expect(fieldValues(material, QR_SOURCE)).toMatchObject({ totalAmount: '96.19', invoiceNumber: '26312000000101557402' });
    expect(fieldValues(material, EINVOICE)).toMatchObject({ totalAmount: '69.19' });
    expect(material.checkText).toContain('二维码与票面不一致');
    expect(material.checkText).toContain('价税合计 票面 69.19，二维码 96.19');
    // The only item is the missing expense city of a ride-hailing invoice alone (#188) — the same one the agreeing
    // QR leaves behind. Nothing about the QR is answerable, so nothing about it is asked.
    expect(snapshot.pendingItems.map((item) => item.itemId)).toEqual([`category_city_missing.${material.materialId}`]);
  });

  it('a QR that agrees is noted in the check text and blocks nothing', async () => {
    await useParser(inlineExecutor());
    const amap = sample('m03');
    const snapshot = await inventory('pending', [{ ...amap, bytes: await withQr(amap.bytes, '01,32,,26312000000101557402,69.19,20260813,,A1B2C3D4') }]);
    const material = byFileName(snapshot, amap.name);
    expect(material).toMatchObject({ checkText: expect.stringContaining('二维码核对一致') });
    // The QR raises nothing; the only item is the missing expense city of a ride-hailing invoice alone (#188).
    expect(snapshot.pendingItems.map((item) => item.itemId)).toEqual([`category_city_missing.${material.materialId}`]);
  });

  it('an undecodable QR is advisory: the invoice is ok, raises no 待确认项 and forms its candidate line', async () => {
    // The fixture's QR box is a placeholder, so no code decodes.
    const { reached: snapshot } = await scenario(server, signedIn).at('project', { materials: ['m01'], projectBook: 'as_is' });
    const hotel = byFileName(snapshot, sample('m01').name);
    expect(hotel).toMatchObject({ status: 'ok', role: 'primary_voucher', categoryLabel: '住宿', checkText: expect.stringContaining('二维码无法识读') });
    expect(snapshot.pendingItems.filter((item) => !item.itemId.startsWith('stay_'))).toEqual([]);
    // A clean inventory goes on to 项目归属; with an empty personal book, to maintaining it first (#188).
    expect(snapshot).toMatchObject({ stage: 'project', step: { kind: 'maintain_project_book' } });
    expect(snapshot.events).toEqual([expect.objectContaining({ no: 1, voucherMaterialId: hotel.materialId, category: { code: 'accommodation', label: '住宿' }, date: '2026-08-22', grossAmount: '3640.00' })]);
    expect(snapshot.lines).toEqual([
      expect.objectContaining({
        no: 1,
        voucherMaterialId: hotel.materialId,
        invoiceLabel: '发票1',
        description: '住宿费',
        maskedNumber: '2631************7734',
        grossAmount: '3640.00',
        netAmount: '3433.96',
        taxAmount: '206.04',
      }),
    ]);
  });
});

describe('dispatch on hard anchors', () => {
  it('several matching layouts raise a blocking 待确认项 instead of first-match-wins', async () => {
    await useParser(inlineExecutor([...LAYOUTS, { ...einvoice, name: 'einvoice_copy', label: '全电发票（另一版式）' }]));
    const snapshot = await inventory('pending', ['m01']);

    const hotel = byFileName(snapshot, sample('m01').name);
    expect(hotel).toMatchObject({ kind: null, layout: null, status: 'pending', fields: [] });
    expect(snapshot.pendingItems).toHaveLength(1);
    expect(snapshot.pendingItems[0]).toMatchObject({ materialId: hotel.materialId, kind: 'choice', status: 'open', resolver: '要你处理' });
    expect(snapshot.pendingItems[0]?.choices.map((choice) => choice.key)).toEqual(['layout:vat_invoice/einvoice', 'layout:vat_invoice/einvoice_copy', 'exclude']);
    expect(snapshot.lines).toEqual([]);
    expect(snapshot.stage).toBe('pending');
    expect(snapshot.step.kind).toBe('answer_pending');
  });
});

// Holds every parse until released, so a test can act while the job runs.
function gated(): { executor: ParseExecutor; release: () => void } {
  let release = () => {};
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  const inner = inlineExecutor();
  return {
    release: () => release(),
    executor: {
      parse: async (input) => {
        await opened;
        return inner.parse(input);
      },
      close: async () => release(),
    },
  };
}

describe('the background parser job', () => {
  it('while it runs the step is none and every mutation gets 409 with the unchanged snapshot', async () => {
    const gate = gated();
    await useParser(gate.executor);
    const { task } = await client.createTask();
    const uploaded = await client.upload(task.taskId, [sample('m01'), sample('m03')]);

    const started = await client.accepted(await client.act(uploaded, 'start-inventory'));
    expect(started).toMatchObject({ stage: 'inventory', step: { kind: 'none' }, inventory: { status: 'running', summary: null } });
    expect(started.inventory.phases).toEqual([expect.objectContaining({ key: 'pdf', status: 'running' })]);

    const running = await client.current(task.taskId);
    const refusedWith409 = async (response: Response) => {
      expect(response.status).toBe(409);
      const failure = ActionFailureSchema.parse(await response.json());
      expect(failure.error.code).toBe('stale_step');
      expect(failure.snapshot).toEqual(running);
    };
    // Even with the current stepToken.
    await refusedWith409(await client.act(running, 'exclude-material', { materialId: running.materials[0]?.materialId }));
    await refusedWith409(await client.act(running, 'reopen-upload'));
    await refusedWith409(await client.uploadRaw(task.taskId, [sample('m05')]));
    await refusedWith409(await signedIn.request(`/api/tasks/${task.taskId}/abandon`, { method: 'POST' }));
    expect(await client.current(task.taskId)).toEqual(running);

    gate.release();
    const done = await client.settled(task.taskId);
    // m03 alone has no expense city, so it waits on category_city_missing (#188); the hotel invoice m01 alone waits on
    // the 住宿 trio check (#213).
    expect(done.materials.map((material) => material.status)).toEqual(['pending', 'pending']);
    expect((await client.act(done, 'exclude-material', { materialId: done.materials[1]?.materialId })).status).toBe(200);
  });

  it('publishes per-material progress: each outcome bumps the revision and lands in the snapshot', async () => {
    // Not a hotel invoice: the 住宿 trio's answers would add revisions of their own.
    const snapshot = await inventory('pending', ['m07', 'm03']);
    // Created (1), uploaded (2), started (3), then one fact per material.
    expect(snapshot.step.stepToken).toBe(`${snapshot.task.taskId}.5`);
    expect(snapshot.inventory.phases).toEqual([expect.objectContaining({ key: 'pdf', status: 'done' })]);
  });
});

describe('restart', () => {
  it("resumes every account's parser job, not only one account's", async () => {
    const gate = gated();
    await useParser(gate.executor);
    const bob = await server.signIn('bob');
    const taskIds: string[] = [];
    for (const who of [client, api(() => bob)]) {
      const { task } = await who.createTask();
      const uploaded = await who.upload(task.taskId, [sample('m01')]);
      expect((await who.accepted(await who.act(uploaded, 'start-inventory'))).inventory.status).toBe('running');
      taskIds.push(task.taskId);
    }

    // Stop mid-job: the gated parse in flight is dropped, nothing is recorded. A fresh app on the same database resumes.
    await server.app.close();
    const restarted = createApp({ db: server.db, dataDir: server.dataDir, now: server.clock.now, parser: inlineExecutor() });
    try {
      const again = (who: TestClient) => api(() => testClient(restarted, who.account, who.cookie));
      const [aliceTask, bobTask] = await Promise.all([again(signedIn).settled(taskIds[0] ?? ''), again(bob).settled(taskIds[1] ?? '')]);
      // Parsed: the hotel invoice alone is read, and waits only on the 住宿 trio check (#213).
      for (const snapshot of [aliceTask, bobTask]) {
        expect(snapshot.materials.map((material) => material.kind)).toEqual(['vat_invoice']);
        expect(snapshot.pendingItems.every((item) => item.itemId.startsWith('stay_'))).toBe(true);
      }
    } finally {
      await restarted.close();
    }
  });
});
