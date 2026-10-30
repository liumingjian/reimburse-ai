import { describe, expect, it } from 'vitest';
import { settleGrid, writeCell, OVERLAY_SHOWN } from './erpform';
import { openNewReimbursement, addDetailRow } from './steps';
import { createFakeErp } from './testing/fake-erp';
import { FAST_PACE, fakeErpOptions } from './testing/scenario';

describe('write preconditions on the ERP page', () => {
  it('recovers a grid observation without treating an unreadable interval as quiet', async () => {
    const fake = await createFakeErp(fakeErpOptions());
    await openNewReimbursement({ session: fake.session, pace: FAST_PACE });
    const send = fake.session.send.bind(fake.session);
    let reads = 0;
    fake.session.send = (method, params, options) => {
      if (method === 'Runtime.evaluate' && ++reads === 2) return Promise.reject(new Error('grid unreadable once'));
      return send(method, params, options);
    };
    await expect(settleGrid(fake.session, 0, { quietMs: 1, maxMs: 100 }))
      .resolves.toEqual({ settled: true });
    expect(reads).toBeGreaterThanOrEqual(4);
  });

  it('does not type into a grid whose values continue changing', async () => {
    const fake = await createFakeErp(fakeErpOptions());
    await openNewReimbursement({ session: fake.session, pace: FAST_PACE });
    const send = fake.session.send.bind(fake.session);
    let revision = 0;
    fake.session.send = (method, params, options) => {
      if (method === 'Runtime.evaluate') {
        const cell = fake.document.querySelector('.kd-grid-panel[data-grid="detail"] tbody td');
        if (cell) cell.textContent = String(++revision);
      }
      return send(method, params, options);
    };
    fake.commands.length = 0;
    expect(await writeCell(fake.session, { column: '项目', value: '39163', pace: FAST_PACE }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('网格一直没有稳定') });
    expect(fake.commands.filter(c => c.method.startsWith('Input.'))).toEqual([]);
  });

  it('does not type after the overlay wait expires', async () => {
    const fake = await createFakeErp(fakeErpOptions());
    await openNewReimbursement({ session: fake.session, pace: FAST_PACE });
    const send = fake.session.send.bind(fake.session);
    fake.session.send = (method, params, options) => {
      if (method === 'Runtime.evaluate' && params?.expression === OVERLAY_SHOWN) return Promise.resolve({ result: { value: true } });
      return send(method, params, options);
    };
    fake.commands.length = 0;
    expect(await writeCell(fake.session, { column: '项目', value: '39163', pace: { ...FAST_PACE, longMs: 10 } }))
      .toMatchObject({ ok: false, reason: expect.stringContaining('加载遮罩') });
    expect(fake.commands.filter(c => c.method.startsWith('Input.'))).toEqual([]);
  });
  it('does not type when the detail grid remains unreadable', async () => {
    const fake = await createFakeErp(fakeErpOptions());
    await openNewReimbursement({ session: fake.session, pace: FAST_PACE });
    fake.document.querySelector('.kd-grid-panel[data-grid="detail"]')?.remove();
    fake.commands.length = 0;
    const result = await writeCell(fake.session, { column: '项目', value: '39163', pace: FAST_PACE });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('网格') });
    expect(fake.commands.filter(c => c.method.startsWith('Input.'))).toEqual([]);
  });

  it('keeps an unreadable overlay observation from admitting a write', async () => {
    const fake = await createFakeErp(fakeErpOptions());
    await openNewReimbursement({ session: fake.session, pace: FAST_PACE });
    const send = fake.session.send.bind(fake.session);
    fake.session.send = (method, params, options) => {
      if (method === 'Runtime.evaluate' && params?.expression === OVERLAY_SHOWN) return Promise.reject(new Error('overlay unreadable'));
      return send(method, params, options);
    };
    fake.commands.length = 0;
    await expect(writeCell(fake.session, { column: '项目', value: '39163', pace: FAST_PACE }))
      .rejects.toThrow('overlay unreadable');
    expect(fake.commands.filter(c => c.method.startsWith('Input.'))).toEqual([]);
  });

  it('observes a late new row before sending another add command', async () => {
    const fake = await createFakeErp(fakeErpOptions({ newRowClicksLost: 1 }));
    const page = { session: fake.session, pace: FAST_PACE };
    await openNewReimbursement(page);
    const send = fake.session.send.bind(fake.session);
    let clicked = false;
    let delivered = false;
    fake.session.send = async (method, params, options) => {
      if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') clicked = true;
      if (clicked && !delivered && method === 'Runtime.evaluate' && String(params?.expression).includes('kd-ui-blockingExtention-item')) {
        const row = fake.document.querySelector('.kd-grid-panel[data-grid="detail"] tbody tr');
        if (row) row.parentElement!.append(row.cloneNode(true));
        delivered = true;
      }
      return send(method, params, options);
    };
    const before = fake.document.querySelectorAll('.kd-grid-panel[data-grid="detail"] tbody tr:not(.k-footer-template)').length;
    await addDetailRow(page, { timeoutMs: 400 });
    expect(delivered).toBe(true);
    expect(fake.document.querySelectorAll('.kd-grid-panel[data-grid="detail"] tbody tr:not(.k-footer-template)')).toHaveLength(before + 1);
  });
});
