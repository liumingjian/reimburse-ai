import { afterEach, describe, expect, it } from 'vitest';
import type { ParseOutcome } from './parse/dispatch';
import { parseMaterial } from './parse/material';
import { snapshotReaders } from './parse/snapshot';
import { caseDoc } from './parse/testing/snapshot-cases';
import { byFileName, fieldValues, sample, type Upload } from './test/api';
import { loadParsePresets, presetParser, sha256 } from './test/parse-presets';
import { scenario, scenarioServer, type ScenarioServer } from './test/scenario';

let server: ScenarioServer;
afterEach(() => server.close());

describe('hotel pairing with duplicate amounts (#357)', () => {
  it.each([
    { invoices: 2, folios: 1 },
    { invoices: 1, folios: 2 },
    { invoices: 2, folios: 2 },
  ])('leaves $invoices invoices and $folios folios unpaired rather than guessing', async ({ invoices, folios }) => {
    const presets = loadParsePresets();
    const outcomes: Record<string, ParseOutcome> = {};
    const materials: Upload[] = [];
    const groups: [string, number][] = [['m01', invoices], ['m02', folios]];
    for (const [prefix, count] of groups) {
      const original = sample(prefix);
      const preset = Object.entries(presets).find(([name]) => name.startsWith(prefix))?.[1];
      if (!preset || preset.outcome.outcome !== 'recognised') throw new Error(`missing recognised preset for ${prefix}`);
      for (let index = 0; index < count; index++) {
        const bytes = Buffer.concat([original.bytes, Buffer.from(`\n% ${prefix}-${index}`)]);
        materials.push({ ...original, name: `${prefix}-${index}.pdf`, bytes });
        outcomes[sha256(bytes)] = {
          ...preset.outcome,
          candidates: preset.outcome.candidates.map((candidate) => candidate.key === 'invoiceNumber'
            ? { ...candidate, value: index === 0 ? '26312000000098127734' : '26312000000098127735' }
            : candidate),
        };
      }
    }
    server = await scenarioServer({ parser: presetParser(outcomes) });
    const { reached: snapshot } = await scenario(server).at('pending', { materials });
    const invoiceIds = snapshot.materials.filter((material) => material.kind === 'vat_invoice').map((material) => material.materialId);
    const folioIds = snapshot.materials.filter((material) => material.kind === 'hotel_folio').map((material) => material.materialId);

    expect(invoiceIds).toHaveLength(invoices);
    expect(folioIds).toHaveLength(folios);
    expect(snapshot.materials.every((material) => material.linkedMaterialIds.length === 0)).toBe(true);
    expect(snapshot.lines).toHaveLength(invoices);
    for (const line of snapshot.lines) expect(line).toMatchObject({ date: '2026-08-22', referenceMaterialIds: [], grossAmount: '3640.00' });
    expect(snapshot.pendingItems.filter((item) => item.status === 'open').map((item) => item.itemId).sort()).toEqual([
      ...invoiceIds.flatMap((id) => [`stay_folio_missing.${id}`, `stay_screenshot_missing.${id}`]),
      ...folioIds.map((id) => `stay_invoice_missing.${id}`),
    ].sort());
  });
});

describe('结账单 date order in the inventory (#448)', () => {
  // The real 华住 结账单 capture with its 入住 (p1.10) and 离店 (p1.12) value runs edited, parsed by the real 版式 from
  // its snapshot document, and uploaded under bytes of its own.
  async function folio(name: string, checkIn: string, checkOut: string): Promise<[Upload, ParseOutcome]> {
    const doc = caseDoc('hotel-folio-huazhu-colon-run');
    const runs: Record<string, string> = { 'p1.10': `： ${checkIn}`, 'p1.12': `： ${checkOut}` };
    const edited = { ...doc, observations: doc.observations.map((o) => (runs[o.id] ? { ...o, text: runs[o.id] ?? '', raw: runs[o.id] ?? '' } : o)) };
    const bytes = Buffer.from(`%PDF-1.4\n% ${name}\n`);
    const outcome = await parseMaterial({ materialId: name, fileName: name, mime: 'application/pdf', bytes }, snapshotReaders(edited));
    return [{ name, bytes, type: 'application/pdf' }, outcome];
  }

  it('blocks a 离店 earlier than 入住 with a 待确认项; a same-day stay only gets a note', async () => {
    const [reversed, reversedOutcome] = await folio('结账单-颠倒.pdf', '2026-08-13', '2026-08-11');
    const [sameDay, sameDayOutcome] = await folio('结账单-同日.pdf', '2026-07-03', '2026-07-03');
    server = await scenarioServer({ parser: presetParser({ [sha256(reversed.bytes)]: reversedOutcome, [sha256(sameDay.bytes)]: sameDayOutcome }) });
    const { reached: snapshot } = await scenario(server).at('pending', { materials: [reversed, sameDay], stayTrio: 'answered' });

    const blocked = byFileName(snapshot, reversed.name);
    const noted = byFileName(snapshot, sameDay.name);
    expect(snapshot.pendingItems.filter((item) => item.status === 'open')).toEqual([
      expect.objectContaining({
        itemId: `validation_failure.${blocked.materialId}.dates_reversed`,
        materialId: blocked.materialId,
        title: `「${reversed.name}」入住和离店日期颠倒`,
        why: expect.stringContaining('离店日期 2026-08-11 早于入住日期 2026-08-13'),
      }),
    ]);
    expect(noted.checkText).toContain('入住与离店同日（2026-07-03），可能为凌晨入住，请核对原件。');
    expect(fieldValues(noted, 'rule:hotel_folio/labelled')).toMatchObject({ checkIn: '2026-07-03', checkOut: '2026-07-03' });
  });
});
