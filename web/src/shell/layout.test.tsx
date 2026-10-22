import { render, screen, within } from '@testing-library/react';
import { Button } from '@carbon/react';
import { describe, expect, test } from 'vitest';
import { ActionGroup } from './ActionGroup';
import { Card, CardRow } from './Card';
import { DetailList } from './DetailList';
import { FieldGroup } from './FieldGroup';
import { FileName, splitFileName } from './FileName';
import { SummaryBar, SummaryField } from './SummaryBar';

const LONG = 'dzfp_26342000002953010611_安图特（北京）科技有限公司_20260916131451.pdf';

describe('FileName', () => {
  test('keeps the tail of a long name (date stamp and extension) apart from the shrinking head', () => {
    expect(splitFileName(LONG)).toEqual({ head: LONG.slice(0, -12), tail: '16131451.pdf' });
  });

  test('does not split a short name', () => {
    expect(splitFileName('全季酒店_发票.pdf')).toEqual({ head: '全季酒店_发票.pdf', tail: '' });
  });

  test('a short name is one element holding the text and the title', () => {
    render(<FileName name="全季酒店_发票.pdf" title="内容哈希 sha256:0123abcd" />);
    expect(screen.getByText('全季酒店_发票.pdf').getAttribute('title')).toBe('内容哈希 sha256:0123abcd');
  });

  test('the full name is the hover title and the text content', () => {
    render(<FileName name={LONG} />);
    const name = screen.getByTitle(LONG);
    expect(name.textContent).toBe(LONG);
  });
});

describe('FieldGroup', () => {
  test('is a description list on the Carbon grid, one equal column per field', () => {
    render(<FieldGroup label="本地执行器" fields={[{ label: '浏览器', value: 'Chrome' }, { label: '版本', value: '1.1.0' }]} />);
    const list = screen.getByLabelText('本地执行器');
    expect(list.tagName).toBe('DL');
    expect(list.className).toContain('cds--css-grid');
    expect(within(list).getAllByRole('term').map((t) => t.textContent)).toEqual(['浏览器', '版本']);
    expect(list.querySelectorAll('.cds--lg\\:col-span-4')).toHaveLength(2);
  });
});

describe('DetailList', () => {
  test('puts each label left of its value on a Carbon structured list', () => {
    render(<DetailList label="识别字段" fields={[{ label: '发票号码', value: '2634' }]} />);
    const list = screen.getByLabelText('识别字段');
    expect(list.className).toContain('cds--structured-list');
    const row = within(list).getByText('发票号码').parentElement!;
    expect(row.textContent).toBe('发票号码2634');
  });
});

describe('SummaryBar', () => {
  test('is a group holding a description list of equal fields; a sentence-long field spans two', () => {
    render(
      <SummaryBar label="对账摘要">
        <SummaryField label="单据编号" value="BX-1" mono testId="no" />
        <SummaryField label="对账结果" value="已写入，待核对" wide />
      </SummaryBar>,
    );
    const bar = screen.getByRole('group', { name: '对账摘要' });
    expect(bar.firstElementChild!.tagName).toBe('DL');
    expect(within(bar).getAllByRole('definition').map((d) => d.textContent)).toEqual(['BX-1', '已写入，待核对']);
    expect(screen.getByTestId('no').className).toContain('app-code');
    expect(within(bar).getByText('对账结果').parentElement!.className).toContain('app-summary-wide');
  });
});

describe('ActionGroup', () => {
  test('puts the buttons in one Carbon ButtonSet and the caption and error below it', () => {
    render(
      <ActionGroup label="处理" caption="上传后这一项自动消失。" error="上传失败">
        <Button kind="ghost" size="md">排除这份材料</Button>
        <Button size="md">上传支付截图</Button>
      </ActionGroup>,
    );
    const group = screen.getByRole('group', { name: '处理' });
    const [set, caption, error] = Array.from(group.children);
    expect(set!.className).toContain('cds--btn-set');
    expect(within(set as HTMLElement).getAllByRole('button').map((b) => b.textContent)).toEqual(['排除这份材料', '上传支付截图']);
    expect(caption!.textContent).toBe('上传后这一项自动消失。');
    expect(error!.getAttribute('role')).toBe('alert');
  });
});

describe('Card', () => {
  test('is a Carbon Tile with the actions after the body', () => {
    render(
      <CardRow label="去打印或去报销">
        <Card title="去打印" actions={<Button>去打印</Button>}>
          <p>生成合并 PDF。</p>
        </Card>
      </CardRow>,
    );
    const card = screen.getByRole('heading', { name: '去打印' }).parentElement!;
    expect(card.className).toContain('cds--tile');
    expect(Array.from(card.children).map((c) => c.className)).toEqual(['app-card-title', 'app-card-body', 'app-card-actions']);
  });
});
