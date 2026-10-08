import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { AppAdapter, Material } from '@baox/contract';
import { AppProvider } from '../adapter/context';
import type { AppStore } from '../adapter/store';
import { t1Snapshot } from '../mock/fixtures/tasks';
import { PaymentStay } from './PaymentStay';

// 改归属 (ADR-0032): picking a stay submits the field edit `edit.<materialId>.stay`; 「不属于住宿（移除）」 excludes the
// screenshot. The store only records which adapter call each choice makes.

function renderStay(payment: Material['payment']) {
  const snapshot = t1Snapshot('inventory');
  const base = snapshot.materials[0];
  if (!base) throw new Error('fixture has no material');
  const material: Material = { ...base, materialId: 'shot1', fileName: '付款.png', kind: 'payment_screenshot', payment };
  const adapter = { answerPendingItem: vi.fn(async () => ({ ok: true })), excludeMaterial: vi.fn(async () => ({ ok: true })) };
  const store = { act: vi.fn(async (_taskId: string, action: (adapter: AppAdapter) => Promise<unknown>) => action(adapter as unknown as AppAdapter)) } as unknown as AppStore;
  render(
    <AppProvider store={store}>
      <PaymentStay material={material} snapshot={snapshot} />
    </AppProvider>,
  );
  return { adapter, snapshot };
}

const options = [
  { invoiceId: 'inv1', label: '发票1 · 全季酒店 · 价税合计 3640.00' },
  { invoiceId: 'inv2', label: '发票2 · 汉庭 · 价税合计 399.00' },
];

describe('改归属', () => {
  test('shows the stay the screenshot counts for and moves it with a field edit', async () => {
    const { adapter, snapshot } = renderStay({ invoiceId: 'inv1', chosen: false, options });
    const select = screen.getByLabelText<HTMLSelectElement>('改归属：付款.png');
    expect(select.value).toBe('inv1');
    expect([...select.options].map((option) => option.text)).toEqual(['归到 发票1 · 全季酒店 · 价税合计 3640.00', '归到 发票2 · 汉庭 · 价税合计 399.00', '不属于住宿（移除）']);
    fireEvent.change(select, { target: { value: 'inv2' } });
    await vi.waitFor(() => expect(adapter.answerPendingItem).toHaveBeenCalledWith(snapshot.task.taskId, 'edit.shot1.stay', { value: 'inv2' }, snapshot.step.stepToken));
  });

  test('an unplaced screenshot says so, and 移除 excludes it', async () => {
    const { adapter, snapshot } = renderStay({ invoiceId: null, chosen: false, options });
    const select = screen.getByLabelText<HTMLSelectElement>('改归属：付款.png');
    expect(select.options[0]?.text).toBe('还没有归到住宿');
    fireEvent.change(select, { target: { value: 'remove' } });
    await vi.waitFor(() => expect(adapter.excludeMaterial).toHaveBeenCalledWith(snapshot.task.taskId, 'shot1', snapshot.step.stepToken));
    expect(adapter.answerPendingItem).not.toHaveBeenCalled();
  });

  test('renders nothing for a material that is not a 支付截图', () => {
    const { container } = render(<AppProvider store={{} as AppStore}><PaymentStay material={{ ...t1Snapshot('inventory').materials[0]! }} snapshot={t1Snapshot('inventory')} /></AppProvider>);
    expect(container.textContent).toBe('');
  });
});
