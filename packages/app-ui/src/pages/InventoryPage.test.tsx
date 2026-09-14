import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { App } from '../App';
import { BLOCKER_TABLE_COLUMNS } from '../contract/snapshot';
import type { TaskStage } from '../contract/stage';
import { t1Snapshot } from '../mock/fixtures/tasks';
import { createMockAdapter } from '../mock/mock-adapter';
import type { Fault, MockOptions } from '../mock/options';

function renderAt(hash: string, seed: TaskStage | null, fault: Fault | null = null, extra: Partial<MockOptions> = {}) {
  window.location.hash = hash;
  // 阶段间隔 60ms：足够让进度态被看到，又不拖慢用例。
  const adapter = createMockAdapter({ ...extra, seed, fault, inventoryPhaseMs: 60 });
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

// 摘要条里的字段：标签 → 值。
function summaryFields(): Record<string, string> {
  const bar = screen.getByRole('group', { name: '盘点摘要' });
  return Object.fromEntries(Array.from(bar.children).map((field) => [field.children[0]?.textContent ?? '', field.children[1]?.textContent ?? '']));
}

function chooseFiles(names: string[]) {
  const input = screen.getByLabelText('拖入文件，或点击选择');
  const files = names.map((name) => new File([`fixture ${name}`], name, { type: name.endsWith('.jpg') ? 'image/jpeg' : 'application/pdf' }));
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireEvent.change(input);
}

describe('材料盘点', () => {
  test('?seed=inventory：只有材料清单，按费用事件归组，显示配对与守恒结论，不显示字段与来源；入口带待确认项数量', async () => {
    renderAt('#/task/T1/inventory', 'inventory');
    expect(await screen.findByRole('heading', { name: '材料盘点' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '处理 3 个待确认项' }).getAttribute('href')).toBe('#/task/T1/pending');
    // 标题下是摘要条（同整单明细确认），数值与模拟快照里服务端给的汇总一致；页面只有一个大标题。
    const served = t1Snapshot('inventory').inventory;
    const counts = served.summary!;
    expect(summaryFields()).toEqual({
      材料: `${counts.materialCount} 份`,
      通过: `${counts.okCount} 份`,
      需处理: `${counts.pendingMaterialCount} 份`,
      主要报销凭证: `${counts.voucherCount} 份`,
      参考材料: `${counts.referenceCount} 份`,
      盘点版本: served.versionId,
      盘点时间: '2026-09-11 14:20',
    });
    expect(summaryFields()).toMatchObject({ 材料: '11 份', 通过: '8 份', 需处理: '3 份', 盘点版本: 'v1' });
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.queryByText(/份需要你处理/)).toBeNull();
    // 只标记例外：通过的材料不带「通过」徽标。
    // 摘要条里的「通过」是计数字段的标签，不算；只查盘点清单。
    expect(within(screen.getByLabelText('盘点结果')).queryByText('通过', { exact: true })).toBeNull();

    const results = screen.getByLabelText('盘点结果');
    expect(within(results).getAllByRole('columnheader').map((node) => node.textContent)).toEqual(['文件', '识别为', '校验', '份数', '状态']);
    expect(document.body.textContent).not.toMatch(/rule:|user|候选/);
    // 费用事件组（含「未归入费用事件」）是带名称的 tbody；表头 thead 没有名称。
    const groups = within(results)
      .getAllByRole('rowgroup')
      .filter((node) => node.hasAttribute('aria-label'));
    expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual([
      // 统一业务序号按内核确认表的分类排序：外地市内交通 → 长途交通 → 住宿，同一分类内按事件顺序。
      '费用事件 No.1-3',
      '费用事件 No.4',
      '费用事件 No.5',
      '费用事件 No.6',
      '费用事件 No.7',
      '费用事件 No.8',
      '费用事件 No.9',
      '未归入费用事件',
    ]);

    // 全部通过的事件默认收成一行，文件与材料证据关联要点开才看到。
    const amap = groups[0] as HTMLElement;
    const amapToggle = within(amap).getByRole('button');
    expect(amapToggle.textContent).toBe('No.1-3 外地市内交通 08-10 至 08-12 26.69 + 20.85 + 21.65 2 份');
    expect(amapToggle.getAttribute('aria-expanded')).toBe('false');
    expect(within(amap).queryByText('高德打车_发票.pdf')).toBeNull();
    expect(within(amap).queryByText(/^打车发票与行程单配对/)).toBeNull();
    fireEvent.click(amapToggle);
    expect(amapToggle.getAttribute('aria-expanded')).toBe('true');
    expect(within(amap).getByText('打车发票与行程单配对：26.69 + 20.85 + 21.65 = 69.19，按分守恒')).toBeTruthy();
    expect(within(amap).getByText('高德打车_发票.pdf')).toBeTruthy();
    expect(within(amap).getByText('高德打车_行程单.pdf')).toBeTruthy();
    expect(within(amap).getByText('主要报销凭证')).toBeTruthy();
    expect(within(amap).getByText('参考材料')).toBeTruthy();
    expect(within(amap).getByText('26.69 + 20.85 + 21.65 = 69.19，按分守恒')).toBeTruthy();

    const hotel = groups[6] as HTMLElement;
    fireEvent.click(within(hotel).getByRole('button'));
    expect(within(hotel).getByText('住宿发票 3640.00 = 结账单消费合计 3640.00；13 天 = 08-09 入住至 08-22 离店')).toBeTruthy();
    expect(within(hotel).getByText('消费合计 = 发票价税合计；13 天 = 08-09 入住至 08-22 离店')).toBeTruthy();

    // 含待确认材料的事件默认展开，只有待确认的材料带徽标。
    const taxi = groups[3] as HTMLElement;
    expect(within(taxi).getByRole('button').getAttribute('aria-expanded')).toBe('true');
    expect(within(taxi).getByText('待确认')).toBeTruthy();
    expect(within(taxi).getByText('票面年份「26」已补全为 2026；下车时间读数不合法')).toBeTruthy();
    expect(within(taxi).queryByText('90:60')).toBeNull();

    const rest = groups[7] as HTMLElement;
    expect(within(rest).getByText('餐饮_发票.pdf')).toBeTruthy();
    expect(within(rest).getByText('未识别版式')).toBeTruthy();
  });

  test('状态列只放标签、份数单独成列；每个「待确认」标签都带警示图标；页头与摘要条不拼中点串', async () => {
    renderAt('#/task/T1/inventory', 'inventory', 'unsupported-material');
    await screen.findByRole('link', { name: '处理 4 个待确认项' });
    const results = screen.getByLabelText('盘点结果');
    // 事件行：份数在「份数」列的位置。
    for (const toggle of within(results).getAllByRole('button')) fireEvent.click(toggle);
    for (const toggle of within(results).getAllByRole('button')) if (toggle.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle);
    expect(within(results).getByRole('button', { name: /^No\.1-3 / }).textContent).toMatch(/ 2 份$/);

    // 材料行：五个单元格，份数列留空，状态列只有标签（或空）。
    const materialRows = within(results)
      .getAllByRole('row')
      .filter((row) => within(row).queryAllByRole('cell').length === 5);
    expect(materialRows).toHaveLength(11);
    for (const row of materialRows) {
      const cells = within(row).getAllByRole('cell');
      expect(cells[3]?.textContent).toBe('');
      expect(['', '待确认', '已排除', '待盘点']).toContain(cells[4]?.textContent);
    }

    // 「待确认」标签带警示图标：图标只有视觉通道，由 e2e/inventory.spec.ts 在浏览器里检查。
    expect(materialRows.some((row) => within(row).getAllByRole('cell')[4]?.textContent === '待确认')).toBe(true);

    // 「材料证据关联」是单独一行的标签，不和结论连成一句。
    for (const label of within(results).getAllByText('材料证据关联')) expect(label.textContent).toBe('材料证据关联');

    const head = screen.getByRole('heading', { level: 1 }).closest('.app-page-head') as HTMLElement;
    expect(head.textContent).not.toContain('·');
    expect(screen.getByRole('group', { name: '盘点摘要' }).textContent).not.toContain('·');
  });

  test('开始材料盘点后先看到分阶段进度，结束后看到结果与待确认项入口', async () => {
    renderAt('#/task/T1/upload', 'upload');
    await screen.findByRole('button', { name: '拖入文件，或点击选择' });
    chooseFiles(FIXTURE_FILES);
    await screen.findByRole('heading', { name: '上传批次 #1' });
    fireEvent.click(screen.getByRole('button', { name: '开始材料盘点' }));

    expect(await screen.findByRole('heading', { name: '材料盘点' })).toBeTruthy();
    expect(screen.getByLabelText('盘点进度')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/^正在盘点：/);
    expect(screen.getByText('核对材料内容哈希')).toBeTruthy();
    expect(screen.getByText('划分费用事件与待确认项')).toBeTruthy();

    expect(await screen.findByRole('link', { name: '处理 3 个待确认项' })).toBeTruthy();
    expect(screen.queryByLabelText('盘点进度')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^No\.1-3 / }));
    expect(screen.getByText('打车发票与行程单配对：26.69 + 20.85 + 21.65 = 69.19，按分守恒')).toBeTruthy();
    // 步骤条的待确认项带数量。
    expect(within(screen.getByRole('list', { name: '流程阶段' })).getByText('3 项待处理')).toBeTruthy();
  });

  test('?fault=unsupported-material：曹操行程单成为不支持的版式，待确认项变成 4 个', async () => {
    renderAt('#/task/T1/inventory', 'inventory', 'unsupported-material');
    expect(await screen.findByRole('link', { name: '处理 4 个待确认项' })).toBeTruthy();
    expect(summaryFields()).toMatchObject({ 材料: '11 份', 需处理: '4 份' });
    const rest = screen.getByLabelText('未归入费用事件');
    expect(within(rest).getByText('曹操出行_行程单.pdf')).toBeTruthy();
    expect(within(rest).getAllByText('未识别版式')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: /^No\.4 / }));
    expect(screen.getByText('没有找到可配对的行程单，按发票 1 段计一次费用')).toBeTruthy();
  });

  test('?duplicate=1：盘点后跨任务查重命中，整批停，显示重复发票表与命中的任务', async () => {
    renderAt('#/task/T1/upload', 'upload', null, { duplicateHit: true });
    await screen.findByRole('button', { name: '拖入文件，或点击选择' });
    chooseFiles(FIXTURE_FILES);
    await screen.findByRole('heading', { name: '上传批次 #1' });
    fireEvent.click(screen.getByRole('button', { name: '开始材料盘点' }));

    const table = await screen.findByRole('table', { name: '重复发票' }, { timeout: 3000 });
    expect(within(table).getAllByRole('columnheader').map((node) => node.textContent)).toEqual([...BLOCKER_TABLE_COLUMNS]);
    const cells = within(table).getAllByRole('cell').map((node) => node.textContent);
    expect(cells[0]).toBe('1');
    expect(cells[1]).toBe('铁路电子客票_0809.pdf');
    expect(cells[3]).toContain('2026-06 北京培训');
    expect(cells[4]).toBe('要你处理');
    expect(within(screen.getByRole('list', { name: '命中的任务' })).getByText('2026-06 北京培训')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('整批暂停');
    // 整批停：没有费用事件，也没有进入待确认项或项目归属的入口。
    expect(screen.queryByRole('link', { name: /^处理 \d+ 个待确认项$/ })).toBeNull();
    expect(screen.queryByRole('link', { name: '进入项目归属' })).toBeNull();
    expect(screen.getByLabelText('未归入费用事件')).toBeTruthy();

    window.location.hash = '#/task/T1/pending';
    expect(await screen.findByText('这批材料整批暂停，没有形成待确认项。')).toBeTruthy();
    expect(screen.getByRole('table', { name: '重复发票' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: '进入项目归属' })).toBeNull();
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
