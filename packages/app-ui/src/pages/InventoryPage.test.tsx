import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { App } from '../App';
import type { TaskStage } from '../contract/stage';
import { createMockAdapter } from '../mock/mock-adapter';
import type { Fault } from '../mock/options';

function renderAt(hash: string, seed: TaskStage | null, fault: Fault | null = null) {
  window.location.hash = hash;
  // 阶段间隔 60ms：足够让进度态被看到，又不拖慢用例。
  const adapter = createMockAdapter({ seed, fault, inventoryPhaseMs: 60 });
  render(<App adapter={adapter} />);
  return adapter;
}

const FIXTURE_FILES = [
  '全季酒店_发票.pdf',
  '全季酒店_结账单.pdf',
  '高德打车_发票.pdf',
  '高德打车_行程单.pdf',
  '曹操出行_发票.pdf',
  '曹操出行_行程单.pdf',
  '铁路电子客票_0809.pdf',
  '铁路电子客票_0822.pdf',
  'IMG_4871.jpg',
  'IMG_4906.jpg',
  '餐饮_发票.pdf',
];

function chooseFiles(names: string[]) {
  const input = screen.getByLabelText('选择文件');
  const files = names.map((name) => new File([`fixture ${name}`], name, { type: name.endsWith('.jpg') ? 'image/jpeg' : 'application/pdf' }));
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireEvent.change(input);
}

describe('材料盘点', () => {
  test('?seed=inventory：结果按费用事件归组，显示配对与守恒结论、字段候选来源，入口带待确认项数量', async () => {
    renderAt('#/task/T1/inventory', 'inventory');
    expect(await screen.findByRole('heading', { name: '材料盘点' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '处理 3 个待确认项' }).getAttribute('href')).toBe('#/task/T1/pending');
    expect(screen.getByText('通过 8')).toBeTruthy();
    expect(screen.getByText('待确认 3')).toBeTruthy();
    expect(screen.getByText('主要报销凭证 7')).toBeTruthy();
    expect(screen.getByText('参考材料 3')).toBeTruthy();
    expect(screen.getByText('盘点版本 v1 · 2026-09-11 14:20')).toBeTruthy();

    const results = screen.getByLabelText('盘点结果');
    const groups = within(results).getAllByRole('rowgroup').filter((node) => node.classList.contains('event-group'));
    expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual([
      // 统一业务序号按内核确认表的分类排序：外地市内交通 → 长途交通 → 住宿，同一分类内按事件顺序。
      '费用事件 1-3 · 2026-08-10 至 2026-08-12 · 外地市内交通 · 26.69 + 20.85 + 21.65',
      '费用事件 4 · 2026-08-11 · 外地市内交通 · 38.40',
      '费用事件 5 · 2026-08-15 · 外地市内交通 · 32.00',
      '费用事件 6 · 2026-08-19 · 外地市内交通 · 47.00',
      '费用事件 7 · 2026-08-09 · 长途交通 · 73.00',
      '费用事件 8 · 2026-08-22 · 长途交通 · 73.00',
      '费用事件 9 · 2026-08-09 至 2026-08-22 · 住宿 · 3640.00',
      '未归入费用事件',
    ]);

    const amap = groups[0] as HTMLElement;
    expect(within(amap).getByText('打车发票与行程单配对：26.69 + 20.85 + 21.65 = 69.19，按分守恒')).toBeTruthy();
    expect(within(amap).getByText('高德打车_发票.pdf')).toBeTruthy();
    expect(within(amap).getByText('高德打车_行程单.pdf')).toBeTruthy();
    expect(within(amap).getByText('主要报销凭证')).toBeTruthy();
    expect(within(amap).getByText('参考材料')).toBeTruthy();
    expect(within(amap).getAllByText('rule:amap_itinerary').length).toBe(3);
    expect(within(amap).getByText('26.69 + 20.85 + 21.65 = 69.19，按分守恒')).toBeTruthy();

    const hotel = groups[6] as HTMLElement;
    expect(within(hotel).getByText('住宿发票 3640.00 = 结账单消费合计 3640.00；13 天 = 08-09 入住至 08-22 离店')).toBeTruthy();
    expect(within(hotel).getByText('消费合计 = 发票价税合计；13 天 = 08-09 入住至 08-22 离店')).toBeTruthy();

    const taxi = groups[3] as HTMLElement;
    expect(within(taxi).getByText('待确认')).toBeTruthy();
    expect(within(taxi).getByText('90:60')).toBeTruthy();
    expect(within(taxi).getByText('rule:taxi_receipt · 存疑')).toBeTruthy();

    const rest = groups[7] as HTMLElement;
    expect(within(rest).getByText('餐饮_发票.pdf')).toBeTruthy();
    expect(within(rest).getByText('未识别版式')).toBeTruthy();
  });

  test('开始材料盘点后先看到分阶段进度，结束后看到结果与待确认项入口', async () => {
    renderAt('#/task/T1/upload', 'upload');
    await screen.findByText('拖入文件，或点击选择');
    chooseFiles(FIXTURE_FILES);
    await screen.findByRole('heading', { name: '上传批次 #1 · 11 份材料' });
    fireEvent.click(screen.getByRole('button', { name: '开始材料盘点' }));

    expect(await screen.findByRole('heading', { name: '材料盘点' })).toBeTruthy();
    expect(screen.getByLabelText('盘点进度')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/^正在盘点：/);
    expect(screen.getByText('核对材料内容哈希')).toBeTruthy();
    expect(screen.getByText('划分费用事件与待确认项')).toBeTruthy();

    expect(await screen.findByRole('link', { name: '处理 3 个待确认项' })).toBeTruthy();
    expect(screen.queryByLabelText('盘点进度')).toBeNull();
    expect(screen.getByText('打车发票与行程单配对：26.69 + 20.85 + 21.65 = 69.19，按分守恒')).toBeTruthy();
    // 侧栏的待确认项条目带数量。
    expect(within(screen.getByRole('list', { name: '流程阶段' })).getByText('3', { selector: '.count' })).toBeTruthy();
  });

  test('?fault=unsupported-material：曹操行程单成为不支持的版式，待确认项变成 4 个', async () => {
    renderAt('#/task/T1/inventory', 'inventory', 'unsupported-material');
    expect(await screen.findByRole('link', { name: '处理 4 个待确认项' })).toBeTruthy();
    expect(screen.getByText('待确认 4')).toBeTruthy();
    const rest = screen.getByLabelText('未归入费用事件');
    expect(within(rest).getByText('曹操出行_行程单.pdf')).toBeTruthy();
    expect(within(rest).getAllByText('未识别版式')).toHaveLength(2);
    expect(screen.getByText('没有找到可配对的行程单，按发票 1 段计一次费用')).toBeTruthy();
  });

  test('页面守卫：?seed=inventory 下直接打开后续页面显示阶段不可跳过', async () => {
    renderAt('#/task/T1/review', 'inventory');
    expect(await screen.findByRole('heading', { name: '还不能进入这一步' })).toBeTruthy();
    expect(screen.getByText('阶段不可跳过，请按顺序完成前面的步骤。')).toBeTruthy();
    expect(screen.getByRole('link', { name: '回到当前阶段' }).getAttribute('href')).toBe('#/task/T1/inventory');
    window.location.hash = '#/task/T1/print';
    expect(await screen.findByText('阶段不可跳过，请按顺序完成前面的步骤。')).toBeTruthy();
    // 待确认项页在盘点完成后可以进。
    window.location.hash = '#/task/T1/pending';
    expect(await screen.findByRole('heading', { name: '待确认项' })).toBeTruthy();
  });
});
