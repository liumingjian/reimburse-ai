import { PDFDocument, rgb } from '@cantoo/pdf-lib';
import type { Line, Material } from '@baox/contract';
import { describe, expect, it } from 'vitest';
import { pdfContent } from './compose';
import { droppedMaterialsNotice, extraPagesNotice, planPages } from './layout';

// A printed page carries one voucher and one supporting material, and embeds only page 1 of a PDF. Both limits used
// to lose material without a word: a voucher's second 证明材料 and every page after the first just were not there.
// Nothing is placed differently now, but nothing goes missing quietly either.

// planPages only reads these fields; the rest of Line / Material do not take part.
const line = (no: number, voucherMaterialId: string, referenceMaterialIds: string[]): Line =>
  ({
    lineId: `line.${voucherMaterialId}.${no}`,
    no,
    voucherMaterialId,
    referenceMaterialIds,
    date: '2026-08-10',
    endDate: null,
    category: { code: 'accommodation', label: '住宿' },
    grossAmount: '100.00',
  }) as unknown as Line;

const material = (materialId: string, linkedMaterialIds: string[] = []): Material => ({ materialId, linkedMaterialIds }) as unknown as Material;

describe('planPages', () => {
  it('keeps the supporting materials that do not fit, instead of dropping all but the first', () => {
    const plans = planPages(
      [line(1, 'm-invoice', ['m-folio', 'm-itinerary'])],
      [material('m-invoice', ['m-receipt']), material('m-folio'), material('m-itinerary'), material('m-receipt')],
    );

    expect(plans).toHaveLength(1);
    // The bottom half still takes the first one, exactly as before.
    expect(plans[0]?.bottomMaterialId).toBe('m-folio');
    // The others are carried out of the planner so the sheet can name them.
    expect(plans[0]?.droppedMaterialIds).toEqual(['m-itinerary', 'm-receipt']);
  });

  it('drops nothing when a voucher has one supporting material or none', () => {
    const one = planPages([line(1, 'm-invoice', ['m-folio'])], [material('m-invoice'), material('m-folio')]);
    expect(one[0]).toMatchObject({ bottomMaterialId: 'm-folio', droppedMaterialIds: [] });

    const none = planPages([line(1, 'm-invoice', [])], [material('m-invoice')]);
    expect(none[0]).toMatchObject({ bottomMaterialId: null, droppedMaterialIds: [] });
  });

  it('never counts the voucher itself or an unknown id as a supporting material', () => {
    const plans = planPages([line(1, 'm-invoice', ['m-invoice', 'm-gone', 'm-folio'])], [material('m-invoice'), material('m-folio')]);
    expect(plans[0]).toMatchObject({ bottomMaterialId: 'm-folio', droppedMaterialIds: [] });
  });
});

describe('pdfContent', () => {
  it('reports how many pages the original has, so the ones left out can be named', async () => {
    const doc = await PDFDocument.create();
    for (let n = 0; n < 3; n += 1) {
      doc.addPage([200, 200]).drawRectangle({ x: 20, y: 20, width: 120, height: 120, color: rgb(0, 0, 0) });
    }
    const content = await pdfContent(new Uint8Array(await doc.save()));
    expect(content.kind).toBe('pdf');
    if (content.kind === 'pdf') expect(content.pageCount).toBe(3);
  }, 60_000);
});

describe('the notices for what the sheet could not carry', () => {
  it('names every dropped file and every page left out', () => {
    expect(droppedMaterialsNotice('No.1', ['行程单.pdf', '水单.pdf'])).toContain('行程单.pdf、水单.pdf');
    expect(droppedMaterialsNotice('No.1', ['行程单.pdf'])).toContain('还有 1 份');
    expect(extraPagesNotice('No.2', '结账单.pdf', 3)).toContain('共 3 页');
    expect(extraPagesNotice('No.2', '结账单.pdf', 3)).toContain('其余 2 页');
  });
});
