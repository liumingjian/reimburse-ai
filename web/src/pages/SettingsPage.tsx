import { useCallback, useState } from 'react';
import { Button, InlineNotification } from '@carbon/react';
import { useAppStore, useLegacyImport } from '../adapter/context';
import { LEGACY_IMPORT_STATUS_LABELS, RESET_COPY, type LegacyImportReport } from '@baox/contract';
import { TASKS_HASH, navigate } from '../router';
import { ConfirmDialog } from '../shell/Dialog';
import { AppShell } from '../shell/AppShell';
import { FieldGroup } from '../shell/FieldGroup';
import { PageHeader } from '../shell/PageHeader';

// 设置页（全局页面，在登录门内）。
// 「完全重置」请服务端清空当前账号自己的数据；成功后换上服务端给出的任务列表（空的），回到任务列表路由。账号与登录状态保留。
// 「旧数据导入」显示创建第一个管理员时那一次导入的结果（故事 81）：导进了什么、哪些旧任务没有迁移；
// 旧数据损坏时逐个文件列出原因，由这个账号修好后重试，或明确跳过。跳过之后导入就此结束。
// 版式：表单页，内容限宽，节与节之间用细分隔线。

export const LEGACY_IMPORT_COPY = {
  title: '旧数据导入',
  lead: '创建第一个管理员时，应用把旧版 baox 的常驻城市、个人项目簿与动过报销系统的旧任务读进来一次。这里只读旧数据，不会改动它。',
  status: '结果',
  at: '时间',
  problems: '旧数据里的问题',
  notMigrated: '没有迁移的旧任务',
  notMigratedNote: '这些旧任务没有动过报销系统，它们的发票仍然是空闲的，可以在新任务里重新上传。',
  retry: '重试导入',
  skip: '跳过导入',
  skipHint: '跳过之后不能再导入，旧数据仍然留在原处。',
  failedHint: '下面这些文件读不出来，所以这次什么都没有导入。修好它们之后可以重试。',
  loading: '正在读取旧数据导入结果…',
  loadFailed: '旧数据导入结果加载失败',
  retryLoad: '重试',
} as const;

function ReportFields({ report }: { report: LegacyImportReport }) {
  return (
    <FieldGroup
      fields={[
        { label: '常驻城市', value: report.homeCity ?? <span className="app-muted">没有</span> },
        { label: '个人项目簿', value: `${report.projects} 个项目` },
        { label: '报销系统草稿已交接', value: `${report.handedOver} 个任务` },
        { label: '转人工', value: `${report.handedOff} 个任务` },
        { label: '发票占用', value: `${report.invoices} 张发票` },
      ]}
    />
  );
}

function LegacyImportSection() {
  const store = useAppStore();
  const state = useLegacyImport();
  const [busy, setBusy] = useState<'retry' | 'skip' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (which: 'retry' | 'skip') => {
    setBusy(which);
    setError(null);
    const outcome = await store.legacyImportAction((adapter) => (which === 'retry' ? adapter.retryLegacyImport() : adapter.skipLegacyImport()));
    setBusy(null);
    if (!outcome.ok) setError(outcome.error.message);
  };

  const view = state.data;
  return (
    <section className="app-form-section" aria-label={LEGACY_IMPORT_COPY.title}>
      <h2 className="app-section-title">{LEGACY_IMPORT_COPY.title}</h2>
      <p>{LEGACY_IMPORT_COPY.lead}</p>
      {state.status === 'error' ? (
        <div className="app-empty">
          <p>{LEGACY_IMPORT_COPY.loadFailed}</p>
          <p>{state.error}</p>
          <Button kind="secondary" onClick={() => void store.loadLegacyImport()}>
            {LEGACY_IMPORT_COPY.retryLoad}
          </Button>
        </div>
      ) : !view ? (
        <p className="app-loading" role="status">
          {LEGACY_IMPORT_COPY.loading}
        </p>
      ) : (
        <>
          <FieldGroup
            fields={[
              { label: LEGACY_IMPORT_COPY.status, value: LEGACY_IMPORT_STATUS_LABELS[view.status] },
              ...(view.at ? [{ label: LEGACY_IMPORT_COPY.at, value: view.at }] : []),
            ]}
          />
          {view.status === 'imported' && view.report ? <ReportFields report={view.report} /> : null}
          {view.report && view.report.notMigrated.length > 0 ? (
            <div className="app-block">
              <h3 className="app-section-title">{LEGACY_IMPORT_COPY.notMigrated}</h3>
              <p className="app-caption">{LEGACY_IMPORT_COPY.notMigratedNote}</p>
              <ul aria-label={LEGACY_IMPORT_COPY.notMigrated}>
                {view.report.notMigrated.map((name) => (
                  <li key={name}>{name}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {view.status === 'failed' && view.report ? (
            <InlineNotification kind="warning" role="status" lowContrast hideCloseButton statusIconDescription="注意" title={LEGACY_IMPORT_COPY.failedHint}>
              <ul aria-label={LEGACY_IMPORT_COPY.problems}>
                {view.report.problems.map((problem) => (
                  <li key={problem.file}>
                    <span className="app-file-name">{problem.file}</span>：{problem.reason}
                  </li>
                ))}
              </ul>
            </InlineNotification>
          ) : null}
          {view.canRetry ? (
            <>
              <div className="app-btn-row">
                <Button kind="tertiary" disabled={busy !== null} onClick={() => void act('retry')}>
                  {LEGACY_IMPORT_COPY.retry}
                </Button>
                <Button kind="ghost" disabled={busy !== null} onClick={() => void act('skip')}>
                  {LEGACY_IMPORT_COPY.skip}
                </Button>
              </div>
              <p className="app-caption">{LEGACY_IMPORT_COPY.skipHint}</p>
            </>
          ) : null}
          {error ? <InlineNotification kind="error" role="alert" lowContrast hideCloseButton statusIconDescription="错误" title={error} /> : null}
        </>
      )}
    </section>
  );
}

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
        <LegacyImportSection />
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
