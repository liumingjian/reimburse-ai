import { useEffect, useState, type ReactNode } from 'react';
import type { PairingHolderKind, PairingView } from '@baox/contract';
import { ConfirmDialog } from '../shell/Dialog';

// 去报销的方式 (#428, spec #412 D; ADR-0019 and ADR-0033 amended): the 本地执行器 and the 浏览器扩展 are alternatives,
// because an account holds one pairing at a time. The 设置页 opens with this one choice and renders only the chosen
// method's section. The choice is derived from the pairing's holder; no separate setting is stored. With nothing
// paired it is the 本地执行器. Flipping it is a page state only: nothing reaches the server until a 配对码 is
// generated, and generating one for the other method while one is paired asks first (`SwitchMethodDialog`).

export type ReimburseMethod = PairingHolderKind;

export const REIMBURSE_METHOD_COPY = {
  legend: '去报销的方式',
  options: { local_executor: '本地执行器（推荐）', extension: '浏览器扩展' } satisfies Record<ReimburseMethod, string>,
  switchTitle: { local_executor: '换成本地执行器', extension: '换成浏览器扩展' } satisfies Record<ReimburseMethod, string>,
  switchBody: {
    local_executor: '换成本地执行器后，浏览器扩展会断开，不能再替你去报销。',
    extension: '换成浏览器扩展后，本地执行器会断开，不能再替你去报销。',
  } satisfies Record<ReimburseMethod, string>,
  switchConfirm: { local_executor: '换成本地执行器', extension: '换成浏览器扩展' } satisfies Record<ReimburseMethod, string>,
  trouble: '安装遇到问题？',
} as const;

/** What holds this account's pairing, or null when nothing is paired (a 配对码 still waiting is no pairing). */
export function pairingHolder(pairing: PairingView | null): ReimburseMethod | null {
  return pairing?.status === 'paired' ? pairing.holder : null;
}

/** Whether generating a 配对码 for `method` would end a pairing the other method holds. */
export function endsOtherMethod(pairing: PairingView | null, method: ReimburseMethod): boolean {
  const holder = pairingHolder(pairing);
  return holder !== null && holder !== method;
}

/**
 * The chosen method: the holder's whenever a pairing lands or changes hands, the employee's flip in between, and the
 * 本地执行器 when nothing was ever paired. Revoking keeps the method the employee is looking at.
 */
export function useReimburseMethod(pairing: PairingView | null): [ReimburseMethod, (method: ReimburseMethod) => void] {
  const holder = pairingHolder(pairing);
  const [picked, setPicked] = useState<ReimburseMethod | null>(null);
  useEffect(() => {
    if (holder !== null) setPicked(holder);
  }, [holder]);
  return [picked ?? holder ?? 'local_executor', setPicked];
}

export function SwitchMethodDialog({ to, busy = false, onConfirm, onCancel }: { to: ReimburseMethod; busy?: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <ConfirmDialog title={REIMBURSE_METHOD_COPY.switchTitle[to]} confirmLabel={REIMBURSE_METHOD_COPY.switchConfirm[to]} busy={busy} onConfirm={onConfirm} onCancel={onCancel}>
      <p>{REIMBURSE_METHOD_COPY.switchBody[to]}</p>
    </ConfirmDialog>
  );
}

// 「安装遇到问题？」 (#429): each method's install help, collapsed by default so the section stays one sentence, one
// action and its 配对码.
export function InstallTrouble({ children }: { children: ReactNode }) {
  return (
    <details className="app-install-trouble">
      <summary>{REIMBURSE_METHOD_COPY.trouble}</summary>
      <div className="app-install-trouble-body">{children}</div>
    </details>
  );
}
