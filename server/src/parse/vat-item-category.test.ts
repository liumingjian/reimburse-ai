import { expect, it } from 'vitest';
import { CATEGORIES, vatItemCategory } from './slots';

it('maps the printed parent-class dining description to hospitality (#370)', () => {
  expect(vatItemCategory('*生产生活服务*餐饮服务')).toBe(CATEGORIES.hospitality);
});

it.each(['餐饮设备维修', '餐饮服务设备', '保洁服务', '会议费'])('does not infer dining from parent-class %s', (description) => {
  expect(vatItemCategory(`*生产生活服务*${description}`)).toBeNull();
});

it('preserves hotel and direct dining classifications', () => {
  expect(vatItemCategory('*生产生活服务*住宿费')).toBe(CATEGORIES.accommodation);
  expect(vatItemCategory('*餐饮服务*餐费')).toBe(CATEGORIES.hospitality);
});
