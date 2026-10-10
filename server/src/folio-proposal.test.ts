import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_DIR } from '@baox/fixtures';
import type { TaskSnapshot } from '@baox/contract';
import { afterEach, describe, expect, it } from 'vitest';
import { proposeFolio, type ProposalStay } from './folio-proposal';
import { cluesOf } from './parse/clues';
import type { ParseDoc } from './parse/doc';
import type { ParseOutcome } from './parse/dispatch';
import { api, byFileName, sample, type Upload } from './test/api';
import type { TestClient } from './test/harness';
import { presetParser, sha256 } from './test/parse-presets';
import { scenario, scenarioServer, type ScenarioServer } from './test/scenario';

// #336 decision 7c: an unrecognised image holding a 住宿 invoice's total and dates near it is proposed as its folio.

const doc = (...texts: string[]): ParseDoc => ({
  mediaType: 'image',
  pageCount: 1,
  codes: [],
  observations: texts.map((text, index) => ({ id: `p1.${index}`, page: 1, x: 0, y: 0, width: 1, height: 1, text, raw: text })),
});

describe('cluesOf', () => {
  it('lists every positive amount and every calendar date once, however printed', () => {
    expect(cluesOf(doc('入住 2026-08-09 14:02', '退房日期:2026年8月22日', '收费 ¥3,640.00', '房费 280.00', '押金 -500.00', '2026/02/30', '电话 021-12345678'))).toEqual({
      amounts: ['280.00', '3640.00'],
      dates: ['2026-08-09', '2026-08-22'],
    });
  });

  it('does not read a longer number as an amount or a date', () => {
    expect(cluesOf(doc('单号 12026-08-091', '流水 3640.001'))).toEqual({ amounts: [], dates: [] });
  });
});

describe('proposeFolio', () => {
  const stay = (invoiceId: string, totalAmount: string, issueDate = '2026-08-22'): ProposalStay => ({ invoiceId, fileName: `${invoiceId}.pdf`, totalAmount, issueDate });
  const clues = (amounts: string[], dates: string[]) => ({ amounts, dates });

  it('proposes the invoice whose total the image holds, the earliest near date as check-in and the latest as check-out', () => {
    expect(proposeFolio(clues(['280.00', '3640.00'], ['2026-07-01', '2026-08-09', '2026-08-15', '2026-08-22']), [stay('a', '3640.00'), stay('b', '280.10')])).toEqual({
      invoiceId: 'a',
      fileName: 'a.pdf',
      checkIn: '2026-08-09',
      checkOut: '2026-08-22',
      folioTotal: '3640.00',
    });
  });

  it('takes dates from 30 days before the issue date to 1 day after', () => {
    expect(proposeFolio(clues(['3640.00'], ['2026-07-23', '2026-08-23']), [stay('a', '3640.00')])).toMatchObject({ checkIn: '2026-07-23', checkOut: '2026-08-23' });
    expect(proposeFolio(clues(['3640.00'], ['2026-07-22', '2026-08-24']), [stay('a', '3640.00')])).toBeNull();
  });

  it('proposes nothing without the exact total, without two near dates, or when the total fits two invoices', () => {
    const dates = ['2026-08-09', '2026-08-22'];
    expect(proposeFolio(clues(['3639.99'], dates), [stay('a', '3640.00')])).toBeNull();
    expect(proposeFolio(clues(['3640.00'], ['2026-08-22']), [stay('a', '3640.00')])).toBeNull();
    expect(proposeFolio(clues(['3640.00'], dates), [stay('a', '3640.00'), stay('b', '3640.00', '2026-08-21')])).toBeNull();
  });
});

describe('an unrecognised image at inventory', () => {
  let server: ScenarioServer | null = null;
  let alice: TestClient;
  afterEach(async () => {
    await server?.close();
    server = null;
  });
  const client = api(() => alice);

  // An image no layout reads, whose text holds `amounts` and `dates`.
  // Bytes after a PNG's end chunk or a PDF's %%EOF keep the file valid and make each its own content.
  function unread(name: string, clues: { amounts: string[]; dates: string[] }, type = 'image/png'): { upload: Upload; outcome: [string, ParseOutcome] } {
    const base = type === 'application/pdf' ? sample('m12').bytes : readFileSync(join(GENERATED_DIR, 'print-pg1.png'));
    const bytes = Buffer.concat([base, Buffer.from(`\n% ${name}\n`)]);
    return { upload: { name, bytes, type }, outcome: [sha256(bytes), { outcome: 'unrecognised', reason: 'no_layout', clues }] };
  }
  async function inventory(materials: ReadonlyArray<string | Upload>, outcomes: [string, ParseOutcome][]): Promise<TaskSnapshot> {
    server = await scenarioServer({ parser: presetParser(Object.fromEntries(outcomes)) });
    alice = await server.signIn('alice');
    return (await scenario(server, alice).at('pending', { materials })).reached;
  }
  const folio = () => unread('水单.jpg', { amounts: ['280.00', '3640.00'], dates: ['2026-08-09', '2026-08-22'] });

  it('is proposed as the 住宿 invoice’s folio, and one click pairs it', async () => {
    const image = folio();
    const start = await inventory(['m01', image.upload], [image.outcome]);
    const invoice = byFileName(start, sample('m01').name);
    const id = byFileName(start, '水单.jpg').materialId;
    const proposed = start.pendingItems.find((item) => item.itemId === `unrecognised.${id}`);
    expect(proposed?.choices[0]).toEqual({ key: `folio:${invoice.materialId}`, label: `是「${sample('m01').name}」的结账单` });
    expect(proposed?.why).toContain('入住 2026-08-09、离店 2026-08-22、消费合计 3640.00');

    const done = await client.accepted(await client.act(start, 'answer-pending', { itemId: `unrecognised.${id}`, answer: { choice: `folio:${invoice.materialId}` } }));
    const filled = byFileName(done, '水单.jpg');
    expect(filled).toMatchObject({ kind: 'hotel_folio', kindLabel: '酒店结账单（按发票确认）', linkedMaterialIds: [invoice.materialId] });
    expect(Object.fromEntries(filled.fields.map((field) => [field.key, field.value]))).toEqual({ checkIn: '2026-08-09', checkOut: '2026-08-22', folioTotal: '3640.00' });
    expect(done.pendingItems.find((item) => item.itemId === `stay_folio_missing.${invoice.materialId}`)).toBeUndefined();
  });

  it('is not proposed when the invoice has its folio, or when it is not an image', async () => {
    const image = folio();
    const paired = await inventory(['m01', 'm02', image.upload], [image.outcome]);
    expect(paired.pendingItems.find((item) => item.itemId === `unrecognised.${byFileName(paired, '水单.jpg').materialId}`)?.choices.map((choice) => choice.key)).toEqual(['exclude', 'reference', 'manual_fill']);
    await server?.close();

    const pdf = unread('水单.pdf', { amounts: ['3640.00'], dates: ['2026-08-09', '2026-08-22'] }, 'application/pdf');
    const start = await inventory(['m01', pdf.upload], [pdf.outcome]);
    expect(start.pendingItems.find((item) => item.itemId === `unrecognised.${byFileName(start, '水单.pdf').materialId}`)?.choices.map((choice) => choice.key)).toEqual(['exclude', 'reference', 'manual_fill']);
  });
});
