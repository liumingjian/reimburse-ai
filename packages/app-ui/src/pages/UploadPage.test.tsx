import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { App } from '../App';
import { UPLOAD_MAX_FILE_BYTES } from '../contract/snapshot';
import { createMockAdapter } from '../mock/mock-adapter';
import type { Fault } from '../mock/options';

function renderUpload(fault: Fault | null = null) {
  window.location.hash = '#/task/T1/upload';
  return render(<App adapter={createMockAdapter({ seed: null, fault })} />);
}

function pdf(name: string, body = '%PDF-1.4 fixture') {
  return new File([body], name, { type: 'application/pdf' });
}

// 用文件选择器上传：jsdom 里 input.files 只读，用 defineProperty 塞进去再触发 change。
function chooseFiles(files: File[]) {
  const input = screen.getByLabelText('选择文件');
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireEvent.change(input);
}

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
  test('新任务先显示拖放区与文件选择按钮', async () => {
    renderUpload();
    expect(await screen.findByText('拖入文件，或点击选择')).toBeTruthy();
    expect(screen.getByRole('button', { name: '选择文件' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '开始材料盘点' })).toBeNull();
  });

  test('逐文件显示接收与拒绝：类型不支持、超过 20MB、HEIC、内容重复', async () => {
    renderUpload();
    await screen.findByText('拖入文件，或点击选择');
    chooseFiles([
      pdf('全季酒店_发票.pdf'),
      new File(['not a receipt'], '备注.txt', { type: 'text/plain' }),
      new File([new Uint8Array(UPLOAD_MAX_FILE_BYTES + 1)], '扫描件.pdf', { type: 'application/pdf' }),
      new File(['heic bytes'], 'IMG_4871.HEIC', { type: 'image/heic' }),
      pdf('全季酒店_发票（副本）.pdf'),
    ]);

    const panel = await batchPanel('上传批次 #1 · 1 份材料');
    expect(within(panel).getByText('拒绝 4 份')).toBeTruthy();

    const ok = rowOf(panel, '全季酒店_发票.pdf');
    expect(within(ok).getByText('已接收')).toBeTruthy();
    expect(within(ok).getByText(/^sha256:[0-9a-f]{8}$/)).toBeTruthy();

    expect(within(rowOf(panel, '备注.txt')).getByText('类型不支持，只接受 PDF、JPG、PNG')).toBeTruthy();
    expect(within(rowOf(panel, '扫描件.pdf')).getByText('超过 20MB')).toBeTruthy();
    expect(within(rowOf(panel, 'IMG_4871.HEIC')).getByText('HEIC 不支持，请在 iPhone 相册导出为 JPG')).toBeTruthy();
    expect(within(rowOf(panel, '全季酒店_发票（副本）.pdf')).getByText('内容重复，与已接收的「全季酒店_发票.pdf」内容相同')).toBeTruthy();
    expect(within(panel).getAllByText('拒绝')).toHaveLength(4);

    expect(screen.getByRole('button', { name: '开始材料盘点' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '追加下一批' })).toBeTruthy();
  });

  test('追加下一批形成上传批次 #2，然后可以开始材料盘点', async () => {
    renderUpload();
    await screen.findByText('拖入文件，或点击选择');
    chooseFiles([pdf('高德打车_发票.pdf', 'amap invoice')]);
    await batchPanel('上传批次 #1 · 1 份材料');

    fireEvent.click(screen.getByRole('button', { name: '追加下一批' }));
    expect(screen.getByText('拖入文件，或点击选择')).toBeTruthy();
    chooseFiles([new File(['png bytes'], 'IMG_4906.png', { type: 'image/png' })]);
    const second = await batchPanel('上传批次 #2 · 1 份材料');
    expect(within(second).getByText('已复制入任务目录')).toBeTruthy();
    expect(screen.queryByText('拖入文件，或点击选择')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '开始材料盘点' }));
    await waitFor(() => expect(window.location.hash).toBe('#/task/T1/inventory'));
    expect(await screen.findByRole('heading', { name: '材料盘点' })).toBeTruthy();
  });

  test('?fault=duplicate-upload 让第二批出现内容重复', async () => {
    renderUpload('duplicate-upload');
    await screen.findByText('拖入文件，或点击选择');
    chooseFiles([pdf('铁路电子客票_0809.pdf', 'rail 0809')]);
    await batchPanel('上传批次 #1 · 1 份材料');
    fireEvent.click(screen.getByRole('button', { name: '追加下一批' }));
    chooseFiles([pdf('铁路电子客票_0822.pdf', 'rail 0822')]);
    const second = await batchPanel('上传批次 #2 · 0 份材料');
    expect(within(second).getByText(/^内容重复/)).toBeTruthy();
  });

  test('有材料但盘点没开始时，后续页面提示阶段不可跳过', async () => {
    renderUpload();
    await screen.findByText('拖入文件，或点击选择');
    chooseFiles([pdf('餐饮_发票.pdf')]);
    await batchPanel('上传批次 #1 · 1 份材料');
    window.location.hash = '#/task/T1/review';
    expect(await screen.findByRole('heading', { name: '还不能进入这一步' })).toBeTruthy();
  });
});
