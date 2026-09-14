import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { App } from '../App';
import { UPLOAD_MAX_FILE_BYTES } from '../contract/snapshot';
import { createMockAdapter } from '../mock/mock-adapter';
import type { Fault } from '../mock/options';
import { UPLOAD_NEXT_STEP, UPLOAD_ORIGINALS_NOTE, UPLOAD_PROMPT, UPLOAD_TITLE } from './UploadPage';

function renderUpload(fault: Fault | null = null) {
  window.location.hash = '#/task/T1/upload';
  return render(<App adapter={createMockAdapter({ seed: null, fault })} />);
}

function pdf(name: string, body = '%PDF-1.4 fixture') {
  return new File([body], name, { type: 'application/pdf' });
}

// 用文件选择器上传：jsdom 里 input.files 只读，用 defineProperty 塞进去再触发 change。
function chooseFiles(files: File[]) {
  const input = screen.getByLabelText(UPLOAD_PROMPT);
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireEvent.change(input);
}

describe('上传区说明', () => {
  test('拖放区里是主文案、链接样式的提示与格式标签，下方说明下一步是开始盘点、原件不会被修改', async () => {
    renderUpload();
    const zone = await screen.findByRole('button', { name: UPLOAD_PROMPT });
    expect(within(zone).getByText(UPLOAD_TITLE)).toBeTruthy();
    expect(within(zone).getByText('点击选择文件')).toBeTruthy();
    for (const format of ['PDF', 'JPG', 'PNG', '单个 ≤ 20MB']) expect(within(zone).getByText(format)).toBeTruthy();
    const region = screen.getByRole('region', { name: '上传文件' });
    expect(within(region).getByText(UPLOAD_NEXT_STEP)).toBeTruthy();
    expect(within(region).getByText(UPLOAD_ORIGINALS_NOTE)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '选择文件' })).toBeNull();
  });
});

async function batchPanel(title: string): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { name: title });
  const panel = heading.closest('section');
  if (!panel) throw new Error(`${title} 不在面板里`);
  return panel;
}

function rowOf(panel: HTMLElement, fileName: string): HTMLElement {
  const row = within(panel).getByText(fileName).closest('li');
  if (!row) throw new Error(`${fileName} 不在文件列表里`);
  return row;
}

describe('上传材料', () => {
  test('新任务先显示拖放区；点提示打开文件选择器', async () => {
    renderUpload();
    const zone = await screen.findByRole('button', { name: UPLOAD_PROMPT });
    expect(screen.queryByRole('button', { name: '开始材料盘点' })).toBeNull();
    const input = screen.getByLabelText(UPLOAD_PROMPT) as HTMLInputElement;
    expect(input.multiple).toBe(true);
    let opened = 0;
    input.addEventListener('click', () => (opened += 1));
    fireEvent.click(zone);
    expect(opened).toBe(1);
    fireEvent.keyDown(zone, { key: 'Enter', code: 'Enter', keyCode: 13 });
    expect(opened).toBe(2);
  });

  test('逐文件显示接收与拒绝：类型不支持、超过 20MB、HEIC、内容重复', async () => {
    renderUpload();
    await screen.findByRole('button', { name: '拖入文件，或点击选择' });
    chooseFiles([
      pdf('全季酒店_发票.pdf'),
      new File(['not a receipt'], '备注.txt', { type: 'text/plain' }),
      new File([new Uint8Array(UPLOAD_MAX_FILE_BYTES + 1)], '扫描件.pdf', { type: 'application/pdf' }),
      new File(['heic bytes'], 'IMG_4871.HEIC', { type: 'image/heic' }),
      pdf('全季酒店_发票（副本）.pdf'),
    ]);

    const panel = await batchPanel('上传批次 #1');
    // 批次信息以带标签的字段组展示，页面文字里没有自己拼的「·」。
    expect(within(panel).getByRole('term').textContent).toBe('材料');
    expect(within(panel).getByRole('definition').textContent).toBe('1 份');
    expect(screen.getByRole('main').textContent).not.toContain('·');
    expect(within(panel).getByText('拒绝 4 份')).toBeTruthy();

    // 已接收的行不打标签，内容哈希只在文件名的悬停提示里；PDF 与图片用不同图标。
    const ok = rowOf(panel, '全季酒店_发票.pdf');
    expect(within(ok).queryByText('已接收')).toBeNull();
    expect(ok.textContent).not.toMatch(/sha256/);
    expect(within(ok).getByText('全季酒店_发票.pdf').getAttribute('title')).toMatch(/^内容哈希 sha256:[0-9a-f]{8}$/);
    expect(within(ok).getByRole('img', { name: 'PDF' })).toBeTruthy();
    expect(within(rowOf(panel, 'IMG_4871.HEIC')).getByRole('img', { name: '图片' })).toBeTruthy();

    expect(within(rowOf(panel, '备注.txt')).getByText('类型不支持，只接受 PDF、JPG、PNG')).toBeTruthy();
    expect(within(rowOf(panel, '扫描件.pdf')).getByText('超过 20MB')).toBeTruthy();
    expect(within(rowOf(panel, 'IMG_4871.HEIC')).getByText('HEIC 不支持，请在 iPhone 相册导出为 JPG')).toBeTruthy();
    expect(within(rowOf(panel, '全季酒店_发票（副本）.pdf')).getByText('内容重复，与已接收的「全季酒店_发票.pdf」内容相同')).toBeTruthy();
    expect(within(panel).getAllByText('拒绝')).toHaveLength(4);

    // Both actions sit in the sticky action bar with the consequence line (#141).
    const next = screen.getByRole('region', { name: '下一步' });
    expect(within(next).getByRole('button', { name: '开始材料盘点' })).toBeTruthy();
    expect(within(next).getByRole('button', { name: '追加下一批' })).toBeTruthy();
    expect(within(next).getByText('开始盘点后，追加或删除材料会形成新的盘点版本。')).toBeTruthy();
  });

  test('追加下一批形成上传批次 #2，然后可以开始材料盘点', async () => {
    renderUpload();
    await screen.findByRole('button', { name: '拖入文件，或点击选择' });
    chooseFiles([pdf('高德打车_发票.pdf', 'amap invoice')]);
    await batchPanel('上传批次 #1');

    fireEvent.click(screen.getByRole('button', { name: '追加下一批' }));
    expect(screen.getByRole('button', { name: '拖入文件，或点击选择' })).toBeTruthy();
    chooseFiles([new File(['png bytes'], 'IMG_4906.png', { type: 'image/png' })]);
    const second = await batchPanel('上传批次 #2');
    expect(within(second).getByText('已复制入任务目录')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '拖入文件，或点击选择' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '开始材料盘点' }));
    await waitFor(() => expect(window.location.hash).toBe('#/task/T1/inventory'));
    expect(await screen.findByRole('heading', { name: '材料盘点' })).toBeTruthy();
  });

  test('?fault=duplicate-upload 让第二批出现内容重复', async () => {
    renderUpload('duplicate-upload');
    await screen.findByRole('button', { name: '拖入文件，或点击选择' });
    chooseFiles([pdf('铁路电子客票_0809.pdf', 'rail 0809')]);
    await batchPanel('上传批次 #1');
    fireEvent.click(screen.getByRole('button', { name: '追加下一批' }));
    chooseFiles([pdf('铁路电子客票_0822.pdf', 'rail 0822')]);
    const second = await batchPanel('上传批次 #2');
    expect(within(second).getByText(/^内容重复/)).toBeTruthy();
  });

  test('有材料但盘点没开始时，后续页面提示阶段不可跳过', async () => {
    renderUpload();
    await screen.findByRole('button', { name: '拖入文件，或点击选择' });
    chooseFiles([pdf('餐饮_发票.pdf')]);
    await batchPanel('上传批次 #1');
    window.location.hash = '#/task/T1/review';
    expect(await screen.findByRole('heading', { name: '还不能进入这一步' })).toBeTruthy();
  });
});
