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
  const input = screen.getByLabelText('选择文件');
  const files = names.map((name) => new File([`fixture ${name}`], name, { type: name.endsWith('.jpg') ? 'image/jpeg' : 'application/pdf' }));
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireEvent.change(input);
}

describe('材料盘点', () => {
  test('?seed=inventory：费用事件可展开表格，列与表头一致，结论只说一次，不显示字段与来源；入口带待确认项数量', async () => {
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
    expect(document.body.textContent).not.toMatch(/rule:|user|候选/);
    // 收起的组行按表头排开：展开按钮列、费用事件、日期、金额、份数、状态。
    const table = screen.getByRole('table', { name: '费用事件' });
    expect(within(table).getAllByRole('columnheader').slice(0, 6).map((node) => node.textContent)).toEqual(['', '费用事件', '日期', '金额', '份数', '状态']);
    // 每组一个展开按钮，可访问名称是「费用事件 No.x」，状态在 aria-expanded。
    const toggles = within(results).getAllByRole('button', { name: /^费用事件 No\./ });
    expect(toggles.map((toggle) => toggle.getAttribute('aria-label'))).toEqual([
      // 统一业务序号按内核确认表的分类排序：外地市内交通 → 长途交通 → 住宿，同一分类内按事件顺序。
      '费用事件 No.1-3',
      '费用事件 No.4',
      '费用事件 No.5',
      '费用事件 No.6',
      '费用事件 No.7',
      '费用事件 No.8',
      '费用事件 No.9',
    ]);
    const cellsOf = (name: string) =>
      within(screen.getByRole('button', { name }).closest('tr') as HTMLElement)
        .getAllByRole('cell')
        .map((cell) => cell.textContent);

    // 全部通过的事件默认收成一行：日期在日期列、金额（每个事件的价税合计，不求和）在金额列。
    const amapToggle = screen.getByRole('button', { name: '费用事件 No.1-3' });
    expect(cellsOf('费用事件 No.1-3')).toEqual(['', 'No.1-3 外地市内交通', '08-10 至 08-12', '26.69 + 20.85 + 21.65', '2 份', '']);
    expect(amapToggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('row', { name: '费用事件 No.1-3' })).toBeNull();
    expect(within(results).queryByText('高德打车_发票.pdf')).toBeNull();
    fireEvent.click(amapToggle);
    expect(amapToggle.getAttribute('aria-expanded')).toBe('true');
    const amap = screen.getByRole('row', { name: '费用事件 No.1-3' });
    // 材料证据关联只出现一次；参考材料的校验文本已被结论说过，不再重复。
    expect(within(amap).getAllByText('材料证据关联')).toHaveLength(1);
    expect(within(amap).getByText('打车发票与行程单配对：26.69 + 20.85 + 21.65 = 69.19，按分守恒')).toBeTruthy();
    expect(within(amap).queryByText('26.69 + 20.85 + 21.65 = 69.19，按分守恒')).toBeNull();
    expect(within(amap).getByText('见材料证据关联')).toBeTruthy();
    // 多事件组列出各事件；材料小表四列：文件（与角色）、识别为、校验、状态。
    expect(within(within(amap).getByRole('list', { name: '费用事件 No.1-3 的明细' })).getAllByRole('listitem')).toHaveLength(3);
    const materials = within(amap).getByRole('table', { name: '费用事件 No.1-3 的材料' });
    expect(within(materials).getAllByRole('columnheader').map((node) => node.textContent)).toEqual(['文件', '识别为', '校验', '状态']);
    expect(within(materials).getByText('高德打车_发票.pdf')).toBeTruthy();
    expect(within(materials).getByText('高德打车_行程单.pdf')).toBeTruthy();
    expect(within(materials).getByText('主要报销凭证')).toBeTruthy();
    expect(within(materials).getByText('参考材料')).toBeTruthy();

    // 单事件组不再列自己的事件行。
    fireEvent.click(screen.getByRole('button', { name: '费用事件 No.9' }));
    const hotel = screen.getByRole('row', { name: '费用事件 No.9' });
    expect(within(hotel).queryByRole('list')).toBeNull();
    expect(within(hotel).getByText('住宿发票 3640.00 = 结账单消费合计 3640.00；13 天 = 08-09 入住至 08-22 离店')).toBeTruthy();
    expect(within(hotel).getByText('消费合计 = 发票价税合计；13 天 = 08-09 入住至 08-22 离店')).toBeTruthy();

    // 含待确认材料的事件默认展开，收起的组行状态列就显示「待确认」；只有待确认的材料带徽标。
    expect(screen.getByRole('button', { name: '费用事件 No.5' }).getAttribute('aria-expanded')).toBe('true');
    expect(cellsOf('费用事件 No.5')[5]).toBe('待确认');
    const taxi = screen.getByRole('row', { name: '费用事件 No.5' });
    expect(within(taxi).getByText('待确认')).toBeTruthy();
    expect(within(taxi).getByText('票面年份「26」已补全为 2026；下车时间读数不合法')).toBeTruthy();
    expect(within(taxi).queryByText('90:60')).toBeNull();

    // 没有归入费用事件的材料单独一节，在表格之后。
    const rest = screen.getByRole('region', { name: '未归入费用事件' });
    expect(table.compareDocumentPosition(rest) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(rest).getByText('餐饮_发票.pdf')).toBeTruthy();
    expect(within(rest).getByText('未识别版式')).toBeTruthy();
    expect(within(rest).getByText('没有形成费用事件的材料：待确认或已排除。')).toBeTruthy();
  });

  test('全部展开与全部收起；用户点过的组记住自己的选择', async () => {
    renderAt('#/task/T1/inventory', 'inventory');
    await screen.findByRole('heading', { name: '材料盘点' });
    const toggles = () => screen.getAllByRole('button', { name: /^费用事件 No\./ });
    fireEvent.click(screen.getByRole('button', { name: '全部展开' }));
    for (const toggle of toggles()) expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByRole('table', { name: /的材料$/ })).toHaveLength(8);
    fireEvent.click(screen.getByRole('button', { name: '全部收起' }));
    for (const toggle of toggles()) expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // 收起后未归入的一节仍在。
    expect(screen.getAllByRole('table', { name: /的材料$/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '费用事件 No.4' }));
    expect(screen.getByRole('button', { name: '费用事件 No.4' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: '费用事件 No.5' }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('button', { name: '全部展开' })).toBeTruthy();
  });

  test('材料行四列、状态列只放标签；每个「待确认」标签都带警示图标；页头与摘要条不拼中点串', async () => {
    renderAt('#/task/T1/inventory', 'inventory', 'unsupported-material');
    await screen.findByRole('link', { name: '处理 4 个待确认项' });
    fireEvent.click(screen.getByRole('button', { name: '全部展开' }));

    const materialRows = screen
      .getAllByRole('table', { name: /的材料$/ })
      .flatMap((table) => within(table).getAllByRole('row'))
      .filter((row) => within(row).queryAllByRole('cell').length > 0);
    expect(materialRows).toHaveLength(11);
    for (const row of materialRows) {
      const cells = within(row).getAllByRole('cell');
      expect(cells).toHaveLength(4);
      expect(['', '待确认', '已排除', '待盘点']).toContain(cells[3]?.textContent);
    }
    // 「待确认」标签带警示图标：图标只有视觉通道，由 e2e/inventory.spec.ts 在浏览器里检查。
    expect(materialRows.some((row) => within(row).getAllByRole('cell')[3]?.textContent === '待确认')).toBe(true);

    // 「材料证据关联」是单独的标签，不和结论连成一段文字。
    for (const label of screen.getAllByText('材料证据关联')) expect(label.textContent).toBe('材料证据关联');

    const head = screen.getByRole('heading', { level: 1 }).closest('.app-page-head') as HTMLElement;
    expect(head.textContent).not.toContain('·');
    expect(screen.getByRole('group', { name: '盘点摘要' }).textContent).not.toContain('·');
  });

  test('开始材料盘点后先看到分阶段进度，结束后看到结果与待确认项入口', async () => {
    renderAt('#/task/T1/upload', 'upload');
    await screen.findByText('拖入文件，或点击选择');
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
    fireEvent.click(screen.getByRole('button', { name: '费用事件 No.1-3' }));
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
    fireEvent.click(screen.getByRole('button', { name: '费用事件 No.4' }));
    expect(screen.getByText('没有找到可配对的行程单，按发票 1 段计一次费用')).toBeTruthy();
  });

  test('?duplicate=1：盘点后跨任务查重命中，整批停，显示重复发票表与命中的任务', async () => {
    renderAt('#/task/T1/upload', 'upload', null, { duplicateHit: true });
    await screen.findByText('拖入文件，或点击选择');
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
