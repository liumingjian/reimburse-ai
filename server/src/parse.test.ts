import { ActionFailureSchema } from '@baox/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inlineExecutor, type ParseExecutor } from './parse/executor';
import { einvoice, QR_SOURCE } from './parse/layouts/einvoice';
import { LAYOUTS } from './parse/layouts';
import { api, byFileName, fieldValues, sample, type Upload } from './test/api';
import { createTestServer, type TestServer } from './test/harness';
import { withQr } from './test/qr-pdf';

// Slice 04 (#183): the background parser job after start-inventory, and the `vat_invoice/einvoice` layout, through
// `app.request()`. Unless a test swaps it, parsing runs in the real parse worker_thread.

let server: TestServer;
beforeEach(async () => {
  server = await createTestServer();
});
afterEach(() => server.close());
const client = api(() => server);

async function useParser(parser: ParseExecutor) {
  await server.close();
  server = await createTestServer({ parser });
}

const EINVOICE = 'rule:vat_invoice/einvoice';

async function inventoriedFiles(files: readonly Upload[]) {
  const { task } = await client.createTask();
  const uploaded = await client.upload(task.taskId, files);
  await client.accepted(await client.act(uploaded, 'start-inventory'));
  return client.settled(task.taskId);
}
const inventoried = (prefixes: readonly string[]) => inventoriedFiles(prefixes.map(sample));

describe('the vat_invoice/einvoice layout on @baox/fixtures', () => {
  it('parses m01, m03 and m05 into their face fields; m06 and m11 stay unrecognised', async () => {
    const snapshot = await inventoried(['m01', 'm03', 'm05', 'm06', 'm11']);

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

    const amap = byFileName(snapshot, sample('m03').name);
    expect(amap).toMatchObject({ kind: 'vat_invoice', layout: 'einvoice', status: 'ok' });
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

    // No v1 layout covers the 曹操 itinerary; a 餐饮 (catering) e-invoice is outside the v1 kinds.
    for (const prefix of ['m06', 'm11']) {
      const material = byFileName(snapshot, sample(prefix).name);
      expect(material).toMatchObject({ kind: null, layout: null, role: 'pending', status: 'pending', fields: [] });
      expect(material.pendingItemIds).toHaveLength(1);
      expect(snapshot.inventory.ungroupedMaterialIds).toContain(material.materialId);
    }
    expect(snapshot.inventory.summary).toMatchObject({ materialCount: 5, okCount: 3, pendingMaterialCount: 2, voucherCount: 3, openPendingItemCount: 2 });
    // Unrecognised materials leave 待确认项 open: the task moves on to pending items.
    expect(snapshot.stage).toBe('pending');
    expect(snapshot.step.kind).toBe('answer_pending');
  });
});

describe('the e-invoice QR code, a second evidence source', () => {
  it('a QR that disagrees with the text layer surfaces as a blocking conflict 待确认项', async () => {
    const amap = sample('m03');
    const snapshot = await inventoriedFiles([{ ...amap, bytes: await withQr(amap.bytes, '01,32,,26312000000101557402,96.19,20260813,,A1B2C3D4') }]);

    const material = byFileName(snapshot, amap.name);
    expect(material).toMatchObject({ kind: 'vat_invoice', layout: 'einvoice', status: 'pending', role: 'pending' });
    expect(fieldValues(material, QR_SOURCE)).toMatchObject({ totalAmount: '96.19', invoiceNumber: '26312000000101557402' });
    expect(fieldValues(material, EINVOICE)).toMatchObject({ totalAmount: '69.19' });
    expect(snapshot.pendingItems).toEqual([
      expect.objectContaining({ materialId: material.materialId, kind: 'choice', status: 'open', why: expect.stringContaining('价税合计 票面 69.19，二维码 96.19') }),
    ]);
    expect(material.pendingItemIds).toEqual(snapshot.pendingItems.map((item) => item.itemId));
    expect(snapshot.stage).toBe('pending');
    expect(snapshot.lines).toEqual([]);
  });

  it('a QR that agrees is noted in the check text and blocks nothing', async () => {
    const amap = sample('m03');
    const snapshot = await inventoriedFiles([{ ...amap, bytes: await withQr(amap.bytes, '01,32,,26312000000101557402,69.19,20260813,,A1B2C3D4') }]);
    const material = byFileName(snapshot, amap.name);
    expect(material).toMatchObject({ status: 'ok', checkText: expect.stringContaining('二维码核对一致') });
    expect(snapshot.pendingItems).toEqual([]);
  });

  it('an undecodable QR is advisory: the invoice is ok, raises no 待确认项 and forms its candidate line', async () => {
    // The fixture's QR box is a placeholder, so no code decodes.
    const snapshot = await inventoried(['m01']);
    const hotel = byFileName(snapshot, sample('m01').name);
    expect(hotel).toMatchObject({ status: 'ok', role: 'primary_voucher', categoryLabel: '住宿', checkText: expect.stringContaining('二维码无法识读') });
    expect(snapshot.pendingItems).toEqual([]);
    expect(snapshot.stage).toBe('inventory');
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
    const snapshot = await inventoried(['m01']);

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
    await refusedWith409(await server.app.request(`/api/tasks/${task.taskId}/abandon`, { method: 'POST' }));
    expect(await client.current(task.taskId)).toEqual(running);

    gate.release();
    const done = await client.settled(task.taskId);
    expect(done.materials.map((material) => material.status)).toEqual(['ok', 'ok']);
    expect((await client.act(done, 'exclude-material', { materialId: done.materials[1]?.materialId })).status).toBe(200);
  });

  it('publishes per-material progress: each outcome bumps the revision and lands in the snapshot', async () => {
    const snapshot = await inventoried(['m01', 'm03']);
    // Created (1), uploaded (2), started (3), then one fact per material.
    expect(snapshot.step.stepToken).toBe(`${snapshot.task.taskId}.5`);
    expect(snapshot.inventory.phases).toEqual([expect.objectContaining({ key: 'pdf', status: 'done' })]);
  });
});
