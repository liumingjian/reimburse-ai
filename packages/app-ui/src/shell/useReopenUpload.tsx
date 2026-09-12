import { useCallback, useState, type ReactNode } from 'react';
import { STALE_STEP_CODE } from '../contract/actions';
import type { TaskSnapshot } from '../contract/snapshot';
import { ConfirmDialog, REOPEN_DIALOG } from './Dialog';
import { useAction } from './useAction';

// 「追加材料」的二次确认（整单明细确认页与上传页共用）：open() 打开弹层；「继续追加」请服务端使确认失效并回到上传阶段，
// 成功后关闭弹层并调用 onReopened；凭据过期时关闭弹层（任务页顶部显示「任务已在别处推进」）；其余失败显示在弹层里。
export function useReopenUpload(snapshot: TaskSnapshot, onReopened: () => void): { open: () => void; dialog: ReactNode } {
  const taskId = snapshot.task.taskId;
  const stepToken = snapshot.step.stepToken;
  const [dialogOpen, setDialogOpen] = useState(false);
  const { busy, error, run, clearError } = useAction(taskId);

  const close = useCallback(() => {
    setDialogOpen(false);
    clearError();
  }, [clearError]);

  const confirm = async () => {
    const outcome = await run((adapter) => adapter.reopenUpload(taskId, stepToken));
    if (outcome.ok) {
      setDialogOpen(false);
      onReopened();
    } else if (outcome.error.code === STALE_STEP_CODE) {
      setDialogOpen(false);
    }
  };

  const dialog = dialogOpen ? (
    <ConfirmDialog title={REOPEN_DIALOG.title} confirmLabel={REOPEN_DIALOG.confirm} busy={busy} error={error} onConfirm={() => void confirm()} onCancel={close}>
      <p className="lead">{REOPEN_DIALOG.body}</p>
    </ConfirmDialog>
  ) : null;

  return { open: () => setDialogOpen(true), dialog };
}
