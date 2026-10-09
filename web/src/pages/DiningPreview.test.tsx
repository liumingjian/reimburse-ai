import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { t1Snapshot } from '../mock/fixtures/tasks';
import { DiningPreview } from './DiningPreview';

test('switches the paired dining invoice and receipt, including when opened from the receipt', () => {
  const base = t1Snapshot('project');
  const original = base.materials[0];
  if (!original) throw new Error('fixture has no material');
  const invoice = { ...original, materialId: 'dining-invoice', kind: 'vat_invoice' as const, fileName: '餐饮_发票.pdf', mediaType: 'image' as const, previewUrl: '/invoice.png', linkedMaterialIds: ['dining-receipt'] };
  const receipt = { ...original, materialId: 'dining-receipt', kind: 'dining_receipt' as const, fileName: '餐饮_小票.pdf', mediaType: 'image' as const, previewUrl: '/receipt.png', linkedMaterialIds: ['dining-invoice'] };
  render(<DiningPreview snapshot={{ ...base, materials: [invoice, receipt] }} materialId={receipt.materialId} />);
  expect(screen.getByRole('img', { name: '餐饮_小票.pdf 原件' }).getAttribute('src')).toBe('/receipt.png');
  fireEvent.click(screen.getByRole('tab', { name: '发票：餐饮_发票.pdf' }));
  expect(screen.getByRole('img', { name: '餐饮_发票.pdf 原件' }).getAttribute('src')).toBe('/invoice.png');
  fireEvent.click(screen.getByRole('tab', { name: '餐饮小票：餐饮_小票.pdf' }));
  expect(screen.getByRole('img', { name: '餐饮_小票.pdf 原件' }).getAttribute('src')).toBe('/receipt.png');
});
