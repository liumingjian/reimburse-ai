import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { App } from '../App';
import type { AppAdapter } from '../contract/adapter';
import { createMockAdapter } from '../mock/mock-adapter';

// jsdom 没有 PointerEvent 时补一个（带 clientX / pointerId 的 MouseEvent），让指针拖动能在单元测试里跑。
beforeAll(() => {
  if (typeof window.PointerEvent === 'undefined') {
    class TestPointerEvent extends MouseEvent {
      readonly pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
      }
    }
    Object.defineProperty(window, 'PointerEvent', { value: TestPointerEvent, configurable: true });
  }
});

function renderPrint(printSheet: boolean) {
  window.location.hash = '#/task/T1/print';
  const adapter = createMockAdapter(printSheet ? { seed: 'actions', fault: null, printSheet: true } : { seed: 'actions', fault: null });
  render(<App adapter={adapter} />);
  return adapter;
}

const pages = () => screen.getByRole('list', { name: '打印稿页面' });
const confirmationStatus = async (adapter: AppAdapter) => (await adapter.getSnapshot('T1')).confirmation.status;

// 原图 900x1200 显示成 450x600：显示像素 x2 = 原图像素。
function stubEditorImage() {
  const image = screen.getByRole('img', { name: 'IMG_4871.jpg 原图' }) as HTMLImageElement;
  Object.defineProperty(image, 'naturalWidth', { value: 900, configurable: true });
  Object.defineProperty(image, 'naturalHeight', { value: 1200, configurable: true });
  image.getBoundingClientRect = () => ({ left: 10, top: 20, width: 450, height: 600, right: 460, bottom: 620, x: 10, y: 20, toJSON: () => ({}) });
  fireEvent.load(image);
}

describe('打印稿预览', () => {
  test('进入页面即生成打印稿：7 页页图，页眉整句来自快照（No.3-5 用普通连字符）', async () => {
    const adapter = renderPrint(false);
    const generate = vi.spyOn(adapter, 'generatePrintSheet');
    expect(await screen.findByRole('list', { name: '打印稿页面' })).toBeTruthy();
    expect(generate).toHaveBeenCalledWith('T1');
    const cards = within(pages()).getAllByRole('listitem').filter((item) => item.classList.contains('page-card'));
    expect(cards).toHaveLength(7);
    expect(cards[2]?.getAttribute('aria-label')).toBe('No.3-5 · 08-10 · 外地市内交通 · 69.19');
    expect(within(cards[2] as HTMLElement).getByText('No.3-5 · 08-10 · 外地市内交通 · 69.19')).toBeTruthy();
    expect(screen.getByTestId('page-image-pg3').getAttribute('src')).toBe('fixtures/print-pg3.png');
  });

  test('住宿发票缺支付截图：顶部提醒，下载链接仍然可用并指向合并 PDF', async () => {
    renderPrint(true);
    const notice = await screen.findByRole('status', { name: '打印提醒' });
    expect(notice.textContent).toContain('No.2 住宿发票还没有支付截图');
    const download = screen.getByRole('link', { name: '下载打印稿 PDF' });
    expect(download.getAttribute('href')).toBe('fixtures/print-sheet.pdf');
    expect(download.getAttribute('download')).toBe('打印稿_2026-08上海出差.pdf');
  });

  test('旋转：页图换成服务端给的新地址；整单明细确认不变', async () => {
    const adapter = renderPrint(true);
    const rotate = vi.spyOn(adapter, 'rotatePlacement');
    fireEvent.click(await screen.findByRole('button', { name: '改为竖放：全季酒店_结账单.pdf' }));
    expect(await screen.findByRole('button', { name: '旋转 90°：全季酒店_结账单.pdf' })).toBeTruthy();
    expect(rotate).toHaveBeenCalledWith('T1', 'pg2', 'bottom', false);
    expect(screen.getByTestId('page-image-pg2').getAttribute('src')).toBe('fixtures/print-pg2-r00.png');
    expect(await confirmationStatus(adapter)).toBe('confirmed');
  });

  test('四角编辑器：拖动角点按原图像素更新坐标，方向键微调，提交四点坐标并显示回执', async () => {
    const adapter = renderPrint(true);
    const crop = vi.spyOn(adapter, 'cropPlacement');
    fireEvent.click(await screen.findByRole('button', { name: '调整四角：IMG_4871.jpg' }));
    const editor = screen.getByRole('region', { name: '四角裁剪' });
    expect(within(editor).getByRole('button', { name: '提交裁剪' }).hasAttribute('disabled')).toBe(true);
    stubEditorImage();
    expect(screen.getByTestId('corner-0').textContent).toBe('左上角(182, 167)');

    // 显示坐标 (110, 70) 相对图片左上 (10, 20) 偏移 (100, 50)，换算到原图是 (200, 100)。
    const handle = within(editor).getByRole('button', { name: '拖动左上角' });
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 101, clientY: 103 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 110, clientY: 70 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 110, clientY: 70 });
    expect(screen.getByTestId('corner-0').textContent).toBe('左上角(200, 100)');
    // 松开后再移动不再拖动。
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 300, clientY: 300 });
    expect(screen.getByTestId('corner-0').textContent).toBe('左上角(200, 100)');
    // 拖出图片范围会被限制在原图内。
    const bottomRight = within(editor).getByRole('button', { name: '拖动右下角' });
    fireEvent.pointerDown(bottomRight, { pointerId: 2, clientX: 329, clientY: 466 });
    fireEvent.pointerMove(bottomRight, { pointerId: 2, clientX: 900, clientY: 900 });
    fireEvent.pointerUp(bottomRight, { pointerId: 2 });
    expect(screen.getByTestId('corner-2').textContent).toBe('右下角(900, 1200)');
    fireEvent.keyDown(bottomRight, { key: 'ArrowLeft', shiftKey: true });
    fireEvent.keyDown(bottomRight, { key: 'ArrowUp' });
    expect(screen.getByTestId('corner-2').textContent).toBe('右下角(890, 1199)');

    fireEvent.click(within(editor).getByRole('button', { name: '提交裁剪' }));
    const receipt = await screen.findByTestId('crop-receipt');
    expect(receipt.textContent).toBe('已提交裁剪：(200, 100) (586, 139) (890, 1199) (234, 921)');
    expect(crop).toHaveBeenCalledWith('T1', 'pg5', 'top', [
      [200, 100],
      [586, 139],
      [890, 1199],
      [234, 921],
    ]);
    expect(screen.queryByRole('region', { name: '四角裁剪' })).toBeNull();
    expect(within(pages()).getByText(/已手动微调裁剪/)).toBeTruthy();
    expect(await confirmationStatus(adapter)).toBe('confirmed');
  });

  test('取消编辑不提交；恢复回到当前坐标', async () => {
    const adapter = renderPrint(true);
    const crop = vi.spyOn(adapter, 'cropPlacement');
    fireEvent.click(await screen.findByRole('button', { name: '调整四角：IMG_4906.jpg' }));
    stubEditorImageFor('IMG_4906.jpg');
    const editor = screen.getByRole('region', { name: '四角裁剪' });
    fireEvent.keyDown(within(editor).getByRole('button', { name: '拖动右上角' }), { key: 'ArrowRight' });
    expect(screen.getByTestId('corner-1').textContent).toBe('右上角(587, 139)');
    fireEvent.click(within(editor).getByRole('button', { name: '恢复' }));
    expect(screen.getByTestId('corner-1').textContent).toBe('右上角(586, 139)');
    fireEvent.click(within(editor).getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('region', { name: '四角裁剪' })).toBeNull();
    expect(crop).not.toHaveBeenCalled();
  });
});

function stubEditorImageFor(fileName: string) {
  const image = screen.getByRole('img', { name: `${fileName} 原图` }) as HTMLImageElement;
  Object.defineProperty(image, 'naturalWidth', { value: 900, configurable: true });
  Object.defineProperty(image, 'naturalHeight', { value: 1200, configurable: true });
  fireEvent.load(image);
}
