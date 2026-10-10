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

it.each([0, 90, -90])('reads a wide-column synthetic receipt rotated %s degrees through real OCR (#370)', async (angle) => {
  const { default: sharp } = await import('sharp');
  const { ocrImage } = await import('./ocr');
  const { snapshotReaders } = await import('./snapshot');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="white"/><g fill="black" font-family="PingFang SC, sans-serif" font-size="36"><text x="480" y="110">结账单</text><text x="70" y="220">商户：测试餐厅</text><text x="70" y="320">日期：2025-01-02</text><text x="70" y="420">家常菜</text><text x="940" y="420">600.00</text><text x="70" y="520">优惠</text><text x="960" y="520">70.00</text><text x="70" y="650">实收金额:</text><text x="940" y="650">530.00</text></g></svg>`;
  const bytes = await sharp(Buffer.from(svg)).rotate(angle).png().toBuffer();
  const observations = await ocrImage(bytes);
  const outcome = await parseMaterial({ materialId: 'wide', fileName: 'wide.png', mime: 'image/png', bytes }, snapshotReaders({ mediaType: 'image', pageCount: 1, codes: [], observations }));
  expect(outcome).toMatchObject({ outcome: 'recognised', kind: 'dining_receipt', missing: [] });
  if (outcome.outcome !== 'recognised') throw new Error('wide receipt was not recognised');
  const candidate = outcome.candidates.find((candidate) => candidate.key === 'paidAmount');
  expect(candidate?.value).toBe('530.00');
  const ids = candidate?.refs.flatMap((ref) => ref.observationIds) ?? [];
  const evidence = observations.filter((observation) => ids.includes(observation.id));
  expect(evidence.length).toBeGreaterThanOrEqual(2);
  for (const observation of evidence) expect(observation.width).toBeGreaterThan(observation.height);
  const label = evidence.find((observation) => observation.text.includes('实收'));
  const value = evidence.find((observation) => observation.text.includes('530'));
  expect(label).toBeDefined();
  expect(value).toBeDefined();
  if (!label || !value) throw new Error('missing printed label or value evidence');
  expect(value.x).toBeGreaterThan(label.x + label.width + 300);
  expect(Math.abs(label.y + label.height / 2 - value.y - value.height / 2)).toBeLessThan(15);
}, 120_000);

it.each([false, true])('keeps sparse vertical text in its original page coordinates with mixed horizontal text %s', async (mixed) => {
  const { default: sharp } = await import('sharp');
  const { ocrImage } = await import('./ocr');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="800"><rect width="1100" height="800" fill="white"/><g font-family="PingFang SC, sans-serif" font-size="36" fill="black"><text transform="translate(950 140) rotate(90)">测试文字</text>${mixed ? '<text x="70" y="140">横向文字第一行</text><text x="70" y="250">横向文字第二行</text><text x="70" y="360">横向文字第三行</text>' : ''}</g></svg>`;
  const observations = await ocrImage(await sharp(Buffer.from(svg)).png().toBuffer());
  const vertical = observations.filter((run) => run.height > run.width * 2);
  expect(vertical).toHaveLength(1);
  expect(vertical[0]?.x).toBeGreaterThan(850);
  if (mixed) expect(observations.filter((run) => run.width > run.height * 2).length).toBeGreaterThanOrEqual(3);
}, 120_000);
