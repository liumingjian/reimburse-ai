import { afterEach, describe, expect, it } from 'vitest';
import type { ParseOutcome } from './parse/dispatch';
import { sample, type Upload } from './test/api';
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
