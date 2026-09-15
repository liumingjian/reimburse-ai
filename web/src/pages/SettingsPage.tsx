import { useCallback, useState } from 'react';
import { Button } from '@carbon/react';
import { useAppStore } from '../adapter/context';
import { RESET_COPY } from '@baox/contract';
import { TASKS_HASH, navigate } from '../router';
import { ConfirmDialog } from '../shell/Dialog';
import { AppShell } from '../shell/AppShell';
import { PageHeader } from '../shell/PageHeader';

// 设置页（全局页面，在登录门内）。
// 「完全重置」请服务端清空当前账号自己的数据；成功后换上服务端给出的任务列表（空的），回到任务列表路由。账号与登录状态保留。
// 版式：表单页，内容限宽，节与节之间用细分隔线。

export function SettingsPage() {
  const store = useAppStore();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = useCallback(() => {
    setOpen(false);
    setError(null);
  }, []);

  const reset = async () => {
    setBusy(true);
    setError(null);
    const outcome = await store.resetAll();
    setBusy(false);
    if (!outcome.ok) {
      setError(outcome.error.message);
      return;
    }
    setOpen(false);
    navigate(TASKS_HASH);
  };

  return (
    <AppShell nav="settings">
      <div className="app-form-page">
        <PageHeader title="设置" lead="本机数据的维护。" />
        <section className="app-form-section" aria-label={RESET_COPY.title}>
          <h2 className="app-section-title">{RESET_COPY.title}</h2>
          <p>{RESET_COPY.body}</p>
          <Button kind="danger--tertiary" onClick={() => setOpen(true)}>
            {RESET_COPY.button}
          </Button>
        </section>
      </div>
      {open ? (
        <ConfirmDialog danger title={RESET_COPY.dialogTitle} confirmLabel={RESET_COPY.confirm} busy={busy} error={error} onConfirm={() => void reset()} onCancel={close}>
          <p>{RESET_COPY.dialogBody}</p>
        </ConfirmDialog>
      ) : null}
    </AppShell>
  );
}
