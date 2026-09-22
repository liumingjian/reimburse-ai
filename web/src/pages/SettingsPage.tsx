import { useCallback, useState } from 'react';
import { Button, InlineNotification } from '@carbon/react';
import { useAppStore, useExtensionPairing, useLegacyImport } from '../adapter/context';
import { compareExtensionVersions, EXTENSION_DOWNLOAD_PATH, EXTENSION_PAIRING_STATUS_LABELS, EXTENSION_VERSION, LEGACY_IMPORT_STATUS_LABELS, RESET_COPY, type LegacyImportReport } from '@baox/contract';
import { TASKS_HASH, navigate } from '../router';
import { ConfirmDialog } from '../shell/Dialog';
import { AppShell } from '../shell/AppShell';
import { FieldGroup } from '../shell/FieldGroup';
import { PageHeader } from '../shell/PageHeader';

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
  pairingTitle: '配对',
  lead: '去报销时，由你自己浏览器里的扩展打开报销系统并按你确认过的内容填写。先把扩展和这个账号配对，它才知道自己替谁做事。',
  independence: '配对与登录互不影响：撤销配对不会退出登录，退出登录也不会撤销配对。',
  status: '状态',
  browser: '浏览器',
  extensionVersion: '扩展版本',
  connection: '连接',
  connected: '已连接',
  disconnected: '没有连接',
  disconnectedHint: '扩展没有连上这个应用。请打开那台电脑的浏览器，确认扩展还装着、也在公司网络里；连上之后这里会自动变成已连接。',
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
  loading: '正在读取配对情况…',
  loadFailed: '配对情况加载失败',
  retryLoad: '重试',
} as const;

// Written for an employee who has never heard of developer mode: one action per step, and every button and switch
// named exactly as the browser labels it. The ERP is always 报销系统, never the English abbreviation (copy.test.ts).
export const EXTENSION_INSTALL_COPY = {
  download: '下载浏览器扩展',
  offeredVersion: (version: string) => `这里提供的扩展版本：${version}`,
  outdated: (installed: string, offered: string) => `你装的扩展是 ${installed} 版，这里提供的是 ${offered} 版。请按下面“升级扩展”的步骤换成新版本。`,
  installTitle: '安装扩展',
  installLead: '扩展只能装在 Chrome 或 Edge 里。它不经过应用商店，而是由你把下载的安装包解压，再交给浏览器加载。照下面的步骤一步步做就行。',
  installSteps: [
    '点击上面的“下载浏览器扩展”，浏览器会下载一个名为 baox-extension.zip 的压缩包。',
    '在“文档”这类不会随手清理的地方新建一个文件夹，例如“报销助手扩展”，把压缩包里的全部文件解压到这个文件夹里。打开它，应该能直接看到 manifest.json 等几个文件。以后不要删除或移动这个文件夹，浏览器每次启动都要从这里读取扩展。',
    '打开浏览器的扩展管理页：Chrome 在地址栏输入 chrome://extensions 后按回车；Edge 输入 edge://extensions 后按回车。',
    '打开开发者模式：Chrome 的开关在页面右上角，叫“开发者模式”；Edge 的开关在页面左侧，叫“开发人员模式”（窗口较窄时先点左上角的菜单按钮才能看到）。开发者模式只是允许加载不来自应用商店的扩展，不会改动浏览器的其他设置。',
    '点击页面上出现的“加载已解压的扩展程序”（Edge 里叫“加载解压缩的扩展”），选中第 2 步的那个文件夹，再点“选择文件夹”。',
    '页面上出现“报销助手”，就装好了。点击浏览器右上角拼图形状的扩展按钮，把“报销助手”固定到工具栏，以后更容易找到。',
    '点击工具栏上的“报销助手”，填入下方生成的配对码。',
  ],
  startupNote: '以后浏览器启动时，可能会提示关闭开发者模式下的扩展。直接关掉这条提示即可，不要选择停用扩展，否则去报销时扩展不在。',
  upgradeTitle: '升级扩展',
  upgradeLead: '扩展不会自动更新。应用升级之后，扩展可能提示版本太旧、连不上，这时按下面的步骤换成新版本。',
  upgradeSteps: [
    '点击上面的“下载浏览器扩展”，下载新的压缩包。',
    '打开安装时建的那个文件夹，删掉里面原有的全部文件，再把新压缩包里的全部文件解压进去。请用原来的文件夹，换一个新文件夹会让浏览器里出现两个扩展。',
    '打开扩展管理页（Chrome 是 chrome://extensions，Edge 是 edge://extensions），在“报销助手”上点击刷新形状的“重新加载”按钮。',
    '看一眼“报销助手”上显示的版本号，和这里提供的版本一致就升级好了。如果扩展提示需要重新配对，就在下方重新生成配对码。',
  ],
  bannerTitle: '去报销时浏览器顶部的提示条',
  bannerBody: '去报销时，扩展会新开一个报销系统的标签页，在那里替你填写。这时浏览器顶部会出现一条提示，写着“报销助手”已开始调试此浏览器，或者正在调试此浏览器。这是正常的：扩展正是靠它把内容填进报销系统，提示条会一直显示到这次填写结束。',
  bannerCancel: '不要点这条提示上的“取消”。点了它，扩展会暂时失去对那个标签页的控制：如果当时它没有正在往报销系统里写，它会重新接管同一个标签页，确认页面没变之后接着做下去；如果正写到一半，这一步有没有生效看不出来，这次去报销就停下，转去对账。请回到应用，按页面上的提示处理。',
} as const;

// The download, the install and upgrade steps, and the debugging banner. The download is a plain link: the server
// assembles the package for its own address on request, so the page does not go through the adapter.
function ExtensionInstallGuide({ installedVersion }: { installedVersion: string | null }) {
  const outdated = installedVersion !== null && compareExtensionVersions(installedVersion, EXTENSION_VERSION) < 0;
  return (
    <>
      <div className="app-btn-row">
        {/* 服务端回 Content-Disposition: attachment，浏览器就地下载，页面不会跳走。 */}
        <Button kind="primary" href={EXTENSION_DOWNLOAD_PATH}>
          {EXTENSION_INSTALL_COPY.download}
        </Button>
      </div>
      <p className="app-caption">{EXTENSION_INSTALL_COPY.offeredVersion(EXTENSION_VERSION)}</p>
      {outdated ? (
        <InlineNotification kind="warning" role="status" lowContrast hideCloseButton statusIconDescription="注意" title={EXTENSION_INSTALL_COPY.outdated(installedVersion, EXTENSION_VERSION)} />
      ) : null}
      <h3 className="app-subhead">{EXTENSION_INSTALL_COPY.installTitle}</h3>
      <p>{EXTENSION_INSTALL_COPY.installLead}</p>
      <ol className="app-guide-steps" aria-label={EXTENSION_INSTALL_COPY.installTitle}>
        {EXTENSION_INSTALL_COPY.installSteps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <p className="app-caption">{EXTENSION_INSTALL_COPY.startupNote}</p>
      <h3 className="app-subhead">{EXTENSION_INSTALL_COPY.upgradeTitle}</h3>
      <p>{EXTENSION_INSTALL_COPY.upgradeLead}</p>
      <ol className="app-guide-steps" aria-label={EXTENSION_INSTALL_COPY.upgradeTitle}>
        {EXTENSION_INSTALL_COPY.upgradeSteps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <h3 className="app-subhead">{EXTENSION_INSTALL_COPY.bannerTitle}</h3>
      <p>{EXTENSION_INSTALL_COPY.bannerBody}</p>
      <p>{EXTENSION_INSTALL_COPY.bannerCancel}</p>
    </>
  );
}

// The pairing panel: the 配对码 goes to the extension, which exchanges it for its credential; this page only ever sees
// which browser is paired, when it last connected, and the way to revoke it.
function ExtensionPairingSection() {
  const store = useAppStore();
  const state = useExtensionPairing();
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
  };

  const view = state.data;
  return (
    <section className="app-form-section" aria-label={EXTENSION_PAIRING_COPY.title}>
      <h2 className="app-section-title">{EXTENSION_PAIRING_COPY.title}</h2>
      <p>{EXTENSION_PAIRING_COPY.lead}</p>
      <p>{EXTENSION_PAIRING_COPY.independence}</p>
      <ExtensionInstallGuide installedVersion={view?.status === 'paired' ? view.version : null} />
      <h3 className="app-subhead">{EXTENSION_PAIRING_COPY.pairingTitle}</h3>
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
          <FieldGroup
            fields={[
              { label: EXTENSION_PAIRING_COPY.status, value: EXTENSION_PAIRING_STATUS_LABELS[view.status] },
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
          {view.status === 'paired' && !view.connected ? <p className="app-caption">{EXTENSION_PAIRING_COPY.disconnectedHint}</p> : null}
          {view.code ? (
            <>
              <InlineNotification kind="success" role="status" lowContrast hideCloseButton statusIconDescription="成功" title={EXTENSION_PAIRING_COPY.code} subtitle={view.code} />
              <p className="app-caption">{EXTENSION_PAIRING_COPY.codeHint}</p>
            </>
          ) : null}
          <div className="app-btn-row">
            <Button kind="tertiary" disabled={busy !== null} onClick={() => void act('issue')}>
              {view.status === 'none' ? EXTENSION_PAIRING_COPY.issue : EXTENSION_PAIRING_COPY.reissue}
            </Button>
            {view.status === 'paired' ? (
              <Button kind="danger--tertiary" disabled={busy !== null} onClick={() => setConfirming(true)}>
                {EXTENSION_PAIRING_COPY.revoke}
              </Button>
            ) : null}
          </div>
          <p className="app-caption">{EXTENSION_PAIRING_COPY.replaceHint}</p>
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
        <Button kind="secondary" href="#/settings/password">修改密码</Button>
        <LegacyImportSection />
        <ExtensionPairingSection />
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
