import type { Inventory, InventoryPhase } from '@baox/contract';
import type { InventoryView } from '../inventory-view';

// The snapshot's `inventory` section (材料盘点, inventory): the run's phases and, once it is done, the summary counts
// over the materials view (`inventory-view.ts`).

const PHASES = { pdf: '读取 PDF 文本层与二维码', photo: '读取照片票面' } as const;

// `versionNo`: the current 盘点版本 (inventory version); 0 = nothing uploaded yet.
export function inventorySection({ progress, materials, openPendingItems }: InventoryView, versionNo: number): Inventory {
  const { status, waitingBy } = progress;
  const phase = (key: keyof typeof PHASES, phaseStatus: InventoryPhase['status']): InventoryPhase => ({ key, label: PHASES[key], status: phaseStatus });
  const phases =
    status === 'not_started'
      ? []
      : [
          phase('pdf', waitingBy.pdf > 0 ? 'running' : 'done'),
          ...(progress.hasImages ? [phase('photo', waitingBy.pdf > 0 ? 'todo' : waitingBy.image > 0 ? 'running' : 'done')] : []),
        ];
  const included = materials.filter((v) => v.status !== 'excluded');
  return {
    status,
    versionId: versionNo > 0 ? `v${versionNo}` : null,
    phases,
    finishedAt: progress.finishedAt,
    summary:
      status === 'done'
        ? {
            materialCount: included.length,
            okCount: included.filter((v) => v.status === 'ok').length,
            pendingMaterialCount: included.filter((v) => v.status === 'pending').length,
            voucherCount: included.filter((v) => v.role === 'primary_voucher').length,
            referenceCount: included.filter((v) => v.role === 'reference').length,
            openPendingItemCount: openPendingItems,
          }
        : null,
    ungroupedMaterialIds: progress.ungroupedMaterialIds,
  };
}
