import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import type { Material } from '@baox/contract';
import { t1Snapshot } from '../mock/fixtures/tasks';
import { DiningPreview } from './DiningPreview';

test('switches the paired dining invoice and receipt, including when opened from the receipt', () => {
  const base = t1Snapshot('project');
  const original = base.materials[0];
  if (!original) throw new Error('fixture has no material');
  const invoice = { ...original, materialId: 'dining-invoice', kind: 'vat_invoice', fileName: '餐饮_发票.pdf', mediaType: 'image', previewUrl: '/invoice.png', linkedMaterialIds: ['dining-receipt'] } satisfies Material;
  const receipt = { ...original, materialId: 'dining-receipt', kind: 'dining_receipt', fileName: '餐饮_小票.pdf', mediaType: 'image', previewUrl: '/receipt.png', linkedMaterialIds: ['dining-invoice'] } satisfies Material;
  render(<DiningPreview snapshot={{ ...base, materials: [invoice, receipt] }} materialId={receipt.materialId} />);
  expect(screen.getByRole('img', { name: '餐饮_小票.pdf 原件' }).getAttribute('src')).toBe('/receipt.png');
  fireEvent.click(screen.getByRole('tab', { name: '发票：餐饮_发票.pdf' }));
  expect(screen.getByRole('img', { name: '餐饮_发票.pdf 原件' }).getAttribute('src')).toBe('/invoice.png');
  fireEvent.click(screen.getByRole('tab', { name: '餐饮小票：餐饮_小票.pdf' }));
  expect(screen.getByRole('img', { name: '餐饮_小票.pdf 原件' }).getAttribute('src')).toBe('/receipt.png');
});
