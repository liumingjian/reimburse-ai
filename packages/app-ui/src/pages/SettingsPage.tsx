import { useCallback, useState } from 'react';
import { useAppStore } from '../adapter/context';
import { RESET_COPY } from '../contract/actions';
import { TASKS_HASH, navigate } from '../router';
import { ConfirmDialog } from '../shell/Dialog';
import { AppShell } from '../shell/AppShell';

// 设置页（全局页面，不在启动门内：身份不一致等整页阻塞时也能从这里完全重置）。
// 「完全重置」请服务端清空本机数据；成功后换上服务端给出的任务列表（未登录），回到任务列表路由，启动门随之显示启动页。

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
      <div className="page-head">
        <div>
          <h1>设置</h1>
          <p className="lead">本机数据的维护。</p>
        </div>
      </div>
      <section className="panel" aria-label={RESET_COPY.title}>
        <h2>{RESET_COPY.title}</h2>
        <p>{RESET_COPY.body}</p>
        <div className="btn-row">
          <button className="btn btn-secondary" type="button" onClick={() => setOpen(true)}>
            {RESET_COPY.button}
          </button>
        </div>
      </section>
      {open ? (
        <ConfirmDialog title={RESET_COPY.dialogTitle} confirmLabel={RESET_COPY.confirm} busy={busy} error={error} onConfirm={() => void reset()} onCancel={close}>
          <p>{RESET_COPY.dialogBody}</p>
        </ConfirmDialog>
      ) : null}
    </AppShell>
  );
}
