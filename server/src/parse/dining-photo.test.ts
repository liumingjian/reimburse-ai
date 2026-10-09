import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_DIR } from '@baox/fixtures';
import { expect, it } from 'vitest';
import { parseMaterial } from './material';
import { productionReaders } from './readers-production';

it('recognises a phone photo of a dining receipt through real OCR with the amount actually paid', async () => {
  const fileName = 'm16-dining-receipt-photo.jpg';
  const bytes = new Uint8Array(readFileSync(join(GENERATED_DIR, fileName)));
  const outcome = await parseMaterial({ materialId: 'photo', fileName, mime: 'image/jpeg', bytes }, productionReaders);
  expect(outcome).toMatchObject({ outcome: 'recognised', kind: 'dining_receipt', layout: 'labelled', missing: [] });
  if (outcome.outcome !== 'recognised') throw new Error('photo was not recognised');
  expect(outcome.candidates.find((candidate) => candidate.key === 'paidAmount')?.value).toBe('240.00');
}, 120_000);
