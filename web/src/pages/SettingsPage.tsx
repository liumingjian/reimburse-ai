import { useCallback, useState } from 'react';
import { Button, InlineNotification } from '@carbon/react';
import { Download, Launch } from '@carbon/icons-react';
import { useAppStore, useExtensionPairing, useLegacyImport } from '../adapter/context';
import { compareExtensionVersions, EXTENSION_DOWNLOAD_PATH, EXTENSION_PAIRING_STATUS_LABELS, EXTENSION_VERSION, LEGACY_IMPORT_STATUS_LABELS, RESET_COPY, type LegacyImportReport } from '@baox/contract';
import { SETTINGS_PASSWORD_HASH, SETTINGS_TUTORIAL_HASH, TASKS_HASH, navigate } from '../router';
import { ConfirmDialog } from '../shell/Dialog';
import { AppShell } from '../shell/AppShell';
import { FieldGroup } from '../shell/FieldGroup';
import { PageHeader } from '../shell/PageHeader';
import { EXTENSION_INSTALL_COPY } from './ExtensionTutorialPage';
import { useAutoPair, useExtensionSetup } from './extension-setup';

export { EXTENSION_INSTALL_COPY } from './ExtensionTutorialPage';

// 设置页（全局页面，在登录门内）。
// 「完全重置」请服务端清空当前账号自己的数据；成功后换上服务端给出的任务列表（空的），回到任务列表路由。账号与登录状态保留。
// 「旧数据导入」显示创建第一个管理员时那一次导入的结果（故事 81）：导进了什么、哪些旧任务没有迁移；
// 旧数据损坏时逐个文件列出原因，由这个账号修好后重试，或明确跳过。跳过之后导入就此结束。
// 浏览器扩展 (browser extension): issues a one-time 配对码 (pairing code) that the extension exchanges for its long-lived
// credential; once paired, shows which browser and when it last connected, and offers 撤销配对 (revoke the pairing).
// An account has one pairing at a time, so issuing a new 配对码 voids the old one. The same section offers the
// extension download and the Chrome and Edge install and upgrade steps (ADR-0021: loaded unpacked in developer mode,
// never auto-updated), and explains that the debugging banner during 去报销 is expected, and what its Cancel does:
// the job resumes in the same tab when nothing was being written, and goes to 对账 (reconciliation) when it was (#257).
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
        { label: '报销系统单据已交接', value: `${report.handedOver} 个任务` },
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

export const EXTENSION_PAIRING_COPY = {
  title: '浏览器扩展',
  lead: '浏览器扩展只连接当前应用地址。先下载当前地址提供的扩展，再生成配对码。',
  independence: '配对与登录互不影响：撤销配对不会退出登录，退出登录也不会撤销配对。',
  firstTimeTitle: '第一次连接',
  firstTimeLead: (origin: string) => `还没有连接过浏览器扩展。先从 ${origin} 下载报销助手，再生成配对码，在 Chrome 或 Edge 里输入。`,
  firstTimeAction: '生成配对码',
  waitingTitle: '在扩展里输入配对码',
  waitingLead: (origin: string) => `打开从 ${origin} 下载的 Chrome 或 Edge 报销助手，把下面这串配对码填进去。填好后这里会自动显示已连接。`,
  connectedTitle: '扩展已连接，可以开始去报销',
  connectedLead: (origin: string) => `扩展已连接到 ${origin}。保持这台浏览器打开，回到报销任务后点击去报销。`,
  disconnectedTitle: '扩展暂时没有连接',
  disconnectedLead: (origin: string) => `这台扩展没有连接到 ${origin}。请确认当前地址的扩展仍在运行，或按下面步骤换成当前地址的扩展并重新配对。`,
  reconnect: '重新生成配对码',
  tutorial: '打开安装教程',
  download: '下载浏览器扩展',
  activeOrigin: '当前应用地址',
  migrationTitle: '改用当前地址的扩展',
  migrationLead: (origin: string) => `应用地址变更后，旧扩展不会连接到 ${origin}。`,
  migrationDownload: (origin: string) => `在 ${origin} 下载新的浏览器扩展并解压。`,
  migrationReplace: '在 Chrome 或 Edge 的扩展页移除旧扩展，或用新解压目录替换后点“重新加载”。',
  migrationPair: '回到这里生成新的配对码，并在新扩展中输入。',
  migrationVerify: '看到“已连接”后再去报销。',
  migrationOldPair: (origin: string) => `旧地址的配对不表示已连接到 ${origin}。`,
  status: '状态',
  browser: '浏览器',
  extensionVersion: '扩展版本',
  connection: '连接',
  connected: '已连接',
  disconnected: '没有连接',
  pairedAt: '配对时间',
  lastConnectedAt: '最近连接',
  codeExpiresAt: '配对码有效期至',
  unknownBrowser: '没有记录',
  neverConnected: '还没有连接过',
  code: '配对码',
  codeHint: '把这串字符填进扩展里。它只显示这一次，10 分钟内有效，用过就失效。',
  issue: '生成配对码',
  reissue: '重新生成配对码',
  replaceHint: '一个账号同时只有一个配对。重新生成配对码会让原来配对的扩展立刻失去连接。',
  revoke: '撤销配对',
  revokeConfirm: '确定撤销',
  revokeDialogTitle: '撤销配对',
  revokeDialogBody: '撤销之后，那个浏览器里的扩展不能再替你去报销，要重新配对才行。你在这里仍然是登录状态。',
  checking: '正在检测这台浏览器里的报销助手…',
  outdatedTitle: EXTENSION_INSTALL_COPY.tooOldTitle,
  outdatedLead: EXTENSION_INSTALL_COPY.tooOld,
  pairedHereReconnecting: '这台浏览器里的扩展已经和这个账号配对，正在重新连上应用。稍等片刻后刷新这一页。',
  autoPairing: '正在和这台浏览器里的扩展配对…',
  autoPairFailed: '扩展没能自动完成配对',
  autoPairSilent: '这台浏览器里的扩展没有应答。请打开扩展，把下面的配对码填进去。',
  autoPairConfirming: '这台浏览器里的扩展正在替另一个账号报销。请在扩展弹出的窗口里确认，要不要换成这个账号。',
  autoPairDeclinedTitle: '扩展仍在替另一个账号报销',
  autoPairDeclined: '你在扩展的窗口里选了保留原来的账号，这台浏览器没有任何改动。以后要换成这个账号，刷新这一页再确认一次就行。',
  loading: '正在读取配对情况…',
  loadFailed: '配对情况加载失败',
  retryLoad: '重试',
} as const;

// The pairing panel renders the state from the existing adapter. The page never tracks a second connected flag: the
// server's pairing read is the only authority for whether a browser is paired and connected. What the extension in
// this browser says over the page bridge (`extension-setup.ts`) decides only which step to show: the full install
// and manual 配对码 flow, the upgrade steps alone, or no tutorial at all once this browser is paired to this account.
// An extension that answers but is not paired to this account is paired on the spot (`useAutoPair`, #291), after the
// extension has asked the employee when it acts for another account (#292); the manual flow stays for when it does not
// answer, the switch is declined, or the pairing fails.
function ExtensionPairingSection() {
  const store = useAppStore();
  const state = useExtensionPairing();
  const { step, reprobe } = useExtensionSetup();
  const autoPair = useAutoPair(step, reprobe);
  const [busy, setBusy] = useState<'issue' | 'revoke' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const act = async (which: 'issue' | 'revoke') => {
    setBusy(which);
    setError(null);
    const outcome = await store.extensionPairingAction((adapter) => (which === 'issue' ? adapter.createExtensionPairingCode() : adapter.revokeExtensionPairing()));
    setBusy(null);
    if (!outcome.ok) {
      setError(outcome.error.message);
      return;
    }
    setConfirming(false);
    // Both void the pairing the extension may be holding, so what it said before is stale now.
    reprobe();
  };

  const view = state.data;
  const activeOrigin = view?.activeOrigin ?? '';
  const guided = (step.kind === 'notInstalled' || step.kind === 'notPairedHere' || step.kind === 'pairedElsewhere') && autoPair.status !== 'pairing' && autoPair.status !== 'confirming';
  const next = view?.status === 'paired'
    ? view.connected
      ? { title: EXTENSION_PAIRING_COPY.connectedTitle, lead: EXTENSION_PAIRING_COPY.connectedLead(activeOrigin) }
      : { title: EXTENSION_PAIRING_COPY.disconnectedTitle, lead: EXTENSION_PAIRING_COPY.disconnectedLead(activeOrigin) }
    : view?.status === 'waiting'
      ? { title: EXTENSION_PAIRING_COPY.waitingTitle, lead: EXTENSION_PAIRING_COPY.waitingLead(activeOrigin) }
      : { title: EXTENSION_PAIRING_COPY.firstTimeTitle, lead: EXTENSION_PAIRING_COPY.firstTimeLead(activeOrigin) };
  return (
    <section className="app-form-section" aria-label={EXTENSION_PAIRING_COPY.title}>
      <h2 className="app-section-title">{EXTENSION_PAIRING_COPY.title}</h2>
      <p>{EXTENSION_PAIRING_COPY.lead}</p>
      {state.status === 'error' ? (
        <div className="app-empty">
          <p>{EXTENSION_PAIRING_COPY.loadFailed}</p>
          <p>{state.error}</p>
          <Button kind="secondary" onClick={() => void store.loadExtensionPairing()}>
            {EXTENSION_PAIRING_COPY.retryLoad}
          </Button>
        </div>
      ) : !view ? (
        <p className="app-loading" role="status">
          {EXTENSION_PAIRING_COPY.loading}
        </p>
      ) : (
        <>
          <div className="app-extension-state">
            <div className="app-extension-state-heading">
              <div>
                <h3>{EXTENSION_PAIRING_STATUS_LABELS[view.status]}</h3>
              </div>
              <span className={`app-extension-state-mark app-extension-state-mark-${view.status}`} aria-hidden="true" />
            </div>
            <FieldGroup
              fields={[
                { label: EXTENSION_PAIRING_COPY.activeOrigin, value: view.activeOrigin },
                ...(view.status === 'paired'
                  ? [
                      { label: EXTENSION_PAIRING_COPY.browser, value: view.browser ?? <span className="app-muted">{EXTENSION_PAIRING_COPY.unknownBrowser}</span> },
                      { label: EXTENSION_PAIRING_COPY.extensionVersion, value: view.version ?? <span className="app-muted">{EXTENSION_PAIRING_COPY.unknownBrowser}</span> },
                      { label: EXTENSION_PAIRING_COPY.connection, value: view.connected ? EXTENSION_PAIRING_COPY.connected : EXTENSION_PAIRING_COPY.disconnected },
                      { label: EXTENSION_PAIRING_COPY.pairedAt, value: view.pairedAt ?? '' },
                      { label: EXTENSION_PAIRING_COPY.lastConnectedAt, value: view.lastConnectedAt ?? <span className="app-muted">{EXTENSION_PAIRING_COPY.neverConnected}</span> },
                    ]
                  : []),
                ...(view.status === 'waiting' && view.codeExpiresAt ? [{ label: EXTENSION_PAIRING_COPY.codeExpiresAt, value: view.codeExpiresAt }] : []),
              ]}
            />
          </div>
          {step.kind === 'checking' ? (
            <p className="app-loading" role="status">
              {EXTENSION_PAIRING_COPY.checking}
            </p>
          ) : null}
          {autoPair.status === 'confirming' ? (
            <p className="app-loading" role="status">
              {EXTENSION_PAIRING_COPY.autoPairConfirming}
            </p>
          ) : null}
          {autoPair.status === 'pairing' ? (
            <p className="app-loading" role="status">
              {EXTENSION_PAIRING_COPY.autoPairing}
            </p>
          ) : null}
          {guided && autoPair.status === 'declined' ? (
            <InlineNotification kind="info" role="status" lowContrast hideCloseButton statusIconDescription="提示" title={EXTENSION_PAIRING_COPY.autoPairDeclinedTitle} subtitle={EXTENSION_PAIRING_COPY.autoPairDeclined} />
          ) : null}
          {guided && autoPair.status === 'failed' ? (
            <InlineNotification kind="error" role="alert" lowContrast hideCloseButton statusIconDescription="错误" title={EXTENSION_PAIRING_COPY.autoPairFailed} subtitle={autoPair.message} />
          ) : null}
          {step.kind === 'outdated' ? (
            <div className="app-extension-next">
              <h3>{EXTENSION_PAIRING_COPY.outdatedTitle}</h3>
              <p>{EXTENSION_PAIRING_COPY.outdatedLead(step.installed, step.minimum)}</p>
              <ol className="app-guide-steps" aria-label={EXTENSION_INSTALL_COPY.upgradeTitle}>
                {EXTENSION_INSTALL_COPY.upgradeSteps.map((line) => <li key={line}>{line}</li>)}
              </ol>
              <div className="app-btn-row">
                <Button kind="primary" href={EXTENSION_DOWNLOAD_PATH} renderIcon={Download}>
                  {EXTENSION_PAIRING_COPY.download}
                </Button>
              </div>
            </div>
          ) : null}
          {step.kind === 'pairedHere' ? (
            <>
              <div className="app-extension-next">
                <h3>{view.connected ? EXTENSION_PAIRING_COPY.connectedTitle : EXTENSION_PAIRING_COPY.disconnectedTitle}</h3>
                <p>{view.connected ? EXTENSION_PAIRING_COPY.connectedLead(activeOrigin) : EXTENSION_PAIRING_COPY.pairedHereReconnecting}</p>
              </div>
              <div className="app-btn-row">
                <Button kind="danger--tertiary" disabled={busy !== null} onClick={() => setConfirming(true)}>
                  {EXTENSION_PAIRING_COPY.revoke}
                </Button>
              </div>
              <p className="app-caption">{EXTENSION_PAIRING_COPY.independence}</p>
            </>
          ) : null}
          {guided ? (
            <>
              <div className="app-extension-next">
                <h3>{next.title}</h3>
                <p>{next.lead}</p>
              </div>
              {view.code ? (
                <>
                  {autoPair.status === 'silent' ? <p>{EXTENSION_PAIRING_COPY.autoPairSilent}</p> : null}
                  <InlineNotification kind="success" role="status" lowContrast hideCloseButton statusIconDescription="成功" title={EXTENSION_PAIRING_COPY.code} subtitle={view.code} />
                  <p className="app-caption">{EXTENSION_PAIRING_COPY.codeHint}</p>
                </>
              ) : null}
              {view.status === 'paired' && !view.connected ? (
                <InlineNotification kind="warning" role="status" lowContrast hideCloseButton statusIconDescription="注意" title={EXTENSION_PAIRING_COPY.migrationTitle}>
                  <p>{EXTENSION_PAIRING_COPY.migrationLead(view.activeOrigin)}</p>
                  <ol aria-label={EXTENSION_PAIRING_COPY.migrationTitle}>
                    <li>{EXTENSION_PAIRING_COPY.migrationDownload(view.activeOrigin)}</li>
                    <li>{EXTENSION_PAIRING_COPY.migrationReplace}</li>
                    <li>{EXTENSION_PAIRING_COPY.migrationPair}</li>
                    <li>{EXTENSION_PAIRING_COPY.migrationVerify}</li>
                  </ol>
                  <p>{EXTENSION_PAIRING_COPY.migrationOldPair(view.activeOrigin)}</p>
                </InlineNotification>
              ) : null}
              {view.status === 'paired' && view.version !== null && compareExtensionVersions(view.version, EXTENSION_VERSION) < 0 ? (
                <InlineNotification kind="warning" role="status" lowContrast hideCloseButton statusIconDescription="注意" title={EXTENSION_INSTALL_COPY.outdated(view.version, EXTENSION_VERSION)} />
              ) : null}
              <div className="app-btn-row">
                {view.status === 'none' ? (
                  <Button kind="primary" disabled={busy !== null} onClick={() => void act('issue')}>
                    {EXTENSION_PAIRING_COPY.firstTimeAction}
                  </Button>
                ) : view.status === 'waiting' ? (
                  <Button kind="tertiary" disabled={busy !== null} onClick={() => void act('issue')}>
                    {EXTENSION_PAIRING_COPY.reissue}
                  </Button>
                ) : null}
                {view.status !== 'paired' || !view.connected ? (
                  <Button kind="secondary" href={EXTENSION_DOWNLOAD_PATH} renderIcon={Download}>
                    {EXTENSION_PAIRING_COPY.download}
                  </Button>
                ) : null}
                <Button kind="ghost" href={SETTINGS_TUTORIAL_HASH} target="_blank" rel="noreferrer" renderIcon={Launch}>
                  {EXTENSION_PAIRING_COPY.tutorial}
                </Button>
                {view.status === 'paired' && !view.connected ? (
                  <Button kind="primary" disabled={busy !== null} onClick={() => void act('issue')}>
                    {EXTENSION_PAIRING_COPY.reconnect}
                  </Button>
                ) : null}
                {view.status === 'paired' ? (
                  <>
                    {view.connected ? (
                      <Button kind="tertiary" disabled={busy !== null} onClick={() => void act('issue')}>
                        {EXTENSION_PAIRING_COPY.reissue}
                      </Button>
                    ) : null}
                    <Button kind="danger--tertiary" disabled={busy !== null} onClick={() => setConfirming(true)}>
                      {EXTENSION_PAIRING_COPY.revoke}
                    </Button>
                  </>
                ) : null}
              </div>
              {view.status === 'paired' ? <p className="app-caption">{EXTENSION_PAIRING_COPY.replaceHint}</p> : null}
              {view.status === 'paired' ? <p className="app-caption">{EXTENSION_PAIRING_COPY.independence}</p> : null}
            </>
          ) : null}
          {error ? <InlineNotification kind="error" role="alert" lowContrast hideCloseButton statusIconDescription="错误" title={error} /> : null}
        </>
      )}
      {confirming ? (
        <ConfirmDialog
          danger
          title={EXTENSION_PAIRING_COPY.revokeDialogTitle}
          confirmLabel={EXTENSION_PAIRING_COPY.revokeConfirm}
          busy={busy === 'revoke'}
          error={error}
          onConfirm={() => void act('revoke')}
          onCancel={() => {
            setConfirming(false);
            setError(null);
          }}
        >
          <p>{EXTENSION_PAIRING_COPY.revokeDialogBody}</p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}

export function SettingsPage({ returnTo }: { returnTo?: string }) {
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
        <PageHeader title="设置" lead="先连接浏览器扩展，再回到报销任务开始去报销。" actions={<Button kind="secondary" href={SETTINGS_PASSWORD_HASH}>修改密码</Button>} />
        {returnTo ? (
          <section aria-label="返回报销任务">
            <p>任务选择已保留。连接完成后或暂时不连接，都可以返回原任务；返回不会自动开始填报。</p>
            <Button kind="secondary" href={`${returnTo}?extensionSetup=1`}>返回报销任务</Button>
          </section>
        ) : null}
        <ExtensionPairingSection />
        <LegacyImportSection />
        <details className="app-settings-advanced">
          <summary>高级设置</summary>
          <section className="app-form-section" aria-label={RESET_COPY.title}>
            <h2 className="app-section-title">{RESET_COPY.title}</h2>
            <p>{RESET_COPY.body}</p>
            <Button kind="danger--tertiary" onClick={() => setOpen(true)}>
              {RESET_COPY.button}
            </Button>
          </section>
        </details>
      </div>
      {open ? (
        <ConfirmDialog danger title={RESET_COPY.dialogTitle} confirmLabel={RESET_COPY.confirm} busy={busy} error={error} onConfirm={() => void reset()} onCancel={close}>
          <p>{RESET_COPY.dialogBody}</p>
        </ConfirmDialog>
      ) : null}
    </AppShell>
  );
}
