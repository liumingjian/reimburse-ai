import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, InlineNotification, RadioButton, RadioButtonGroup } from '@carbon/react';
import { Copy } from '@carbon/icons-react';
import { INSTALL_SYSTEMS, LOCAL_EXECUTOR_PAIRING_ERRORS, localExecutorInstallCommand, localExecutorUninstallCommand, type InstallSystem, type LocalExecutorPairAnswer, type LocalExecutorPairingState } from '@baox/contract';
import { useAppStore, useLocalExecutorPort, usePairing, useSession } from '../adapter/context';
import { ActionGroup } from '../shell/ActionGroup';
import { copyText } from '../shell/clipboard';
import { ConfirmDialog } from '../shell/Dialog';
import { ErpCredentialsSection } from './ErpCredentialsSection';

// baox 本地执行器 (ADR-0033, ADR-0035 amended 2026-10-17, ADR-0037): the only way to 去报销, the program that does it on
// this PC in a browser nobody sees. The employee picks Mac or Windows (neither is picked for them) and pastes the one
// command this section shows into Terminal or PowerShell; the 配对码 is inside it, and the script installs, pairs and
// starts the executor. While a 配对码 is pending this section reads the pairing again and again, and turns to 已连接
// by itself when the pairing lands. A code that expires or is replaced takes its command off the page with one
// sentence. The command lives in the 设置页 (`InstallCommand`), so reading the pairing again keeps it.
//
// An executor running on this PC answers on 47319 (`adapter/local-executor-port.ts`): then the section offers one click
// instead, which issues a code and hands it straight over. It is asked again whenever the employee comes back to the
// window, since a browser may hold the first question behind its own permission prompt (Chrome's local network
// access) and answer late or not at all. An executor paired to another 应用账号, and an account connected through
// another PC's executor, are asked about first. 已连接 is the server's word: the account's pairing is paired (every
// pairing is a 本地执行器's, ADR-0037). Connected, the section offers 撤销配对 (uninstalling never
// revokes, story 35), and generating a new install command moves into 「安装遇到问题？」 and asks first, since it
// disconnects the executor that works.
//
// The section is one sentence, its one action and the 配对码 hint (#429). The 报销系统 account form the executor signs
// in with sits here too; the install steps and the uninstall command are folded into
// 「安装遇到问题？」.

export const LOCAL_EXECUTOR_COPY = {
  title: 'baox 本地执行器',
  lead: '装一次就在你的电脑后台用 Chrome 或 Edge 替你去报销，以后开机自动运行、自己更新，不占用你的浏览器窗口。',
  system: '你的电脑',
  systems: { mac: 'Mac', windows: 'Windows' } satisfies Record<InstallSystem, string>,
  generate: '生成安装命令',
  command: '安装命令',
  pasteHint: {
    mac: '打开 Mac 上的「终端」，粘贴这条命令，按回车。',
    windows: '打开 Windows 上的「PowerShell」，粘贴这条命令，按回车。',
  } satisfies Record<InstallSystem, string>,
  codeHint: '命令里带着配对码：10 分钟内有效，用过就失效。装好后这里会自动显示已连接。',
  copy: '复制命令',
  copied: '命令已复制。',
  copyByHand: '没能复制，请选中上面的命令手动复制。',
  waiting: '等待安装完成…',
  expired: '配对码已过期，请重新生成安装命令。',
  connected: '已连接',
  connectedLead: '本地执行器已经连上这个账号，回到报销任务就可以去报销。',
  found: '这台电脑上已经装好了本地执行器，点一下就能把它连到这个账号，不用再打开终端。',
  connectHere: '连接这台电脑的执行器',
  connecting: '正在连接这台电脑的执行器…',
  silent: '这台电脑上的本地执行器没有应答。请用下面的安装命令再装一次。',
  pairFailed: LOCAL_EXECUTOR_PAIRING_ERRORS.failed,
  otherAccountTitle: '换成这个账号',
  otherAccountBody: '这台电脑上的本地执行器正在替另一个应用账号去报销。连接后它改为替这个账号去报销，原来的账号就不能再用它了。',
  otherAccountConfirm: '换成这个账号',
  otherPcTitle: '换成这台电脑',
  otherPcBody: '这个账号现在连着另一台电脑上的本地执行器。连接这台电脑的执行器后，那一台就断开了，不能再替你去报销。',
  otherPcConfirm: '换成这台电脑',
  revoke: '撤销配对',
  revokeTitle: '撤销配对',
  revokeBody: '撤销之后，本地执行器不能再替你去报销，要重新连接才行。你在这里仍然是登录状态。',
  revokeConfirm: '确定撤销',
  reinstallTitle: '重新安装',
  reinstallLead: '本地执行器出了问题、要重新装一次时，在这里生成新的安装命令。',
  reinstallDialogTitle: '重新生成安装命令',
  reinstallBody: '重新生成后，现在连着的本地执行器会断开，要运行新的安装命令才能再连上。',
  reinstallConfirm: '重新生成',
  stepsTitle: '安装步骤',
  steps: [
    '在上面选你的电脑是 Mac 还是 Windows，点「生成安装命令」。',
    'Mac 打开「终端」，Windows 打开「PowerShell」，把命令粘贴进去，按回车。',
    '窗口里显示「已安装，可以关掉这个窗口」后，这里会自动显示已连接。',
    '窗口里显示别的提示时，照着提示做。配对码过期了，就回到这里重新生成安装命令。',
    '已经装好、只是没有连上：这里会显示「连接这台电脑的执行器」，点一下就行，不用再打开终端。',
  ],
  uninstallTitle: '卸载本地执行器',
  uninstallLead: '在终端或 PowerShell 里运行你的系统对应的这条命令。卸载不会动你电脑上原有的运行环境，也不会撤销这里的配对。',
  uninstallCommand: '卸载命令',
  trouble: '安装遇到问题？',
  loading: '正在读取配对情况…',
  loadFailed: '配对情况加载失败',
  retryLoad: '重新加载',
} as const;

// How often the pairing is read again while a 配对码 is pending.
export const LOCAL_EXECUTOR_POLL_MS = 1_500;

/** The install command this section generated, and when its 配对码 expires (the pairing read names the same time). */
export type InstallCommand = { system: InstallSystem; text: string; expiresAt: string | null };

const HAN = /\p{Script=Han}/u;

// The executor's refusals (busy, pairing, a code the app did not take) carry a Chinese sentence. An unexpected error
// on the executor, or anything that is not a Chinese sentence, is never shown as it came.
function refusalSentence(answer: Extract<LocalExecutorPairAnswer, { ok: false }>): string {
  return answer.code !== 'local_executor_error' && HAN.test(answer.message) ? answer.message : LOCAL_EXECUTOR_COPY.pairFailed;
}

const unexpired = (expiresAt: string | null) => !expiresAt || Date.parse(expiresAt) > Date.now();

type Agreed = { otherPc?: boolean; otherAccount?: boolean };

export function LocalExecutorSection({ command, onCommand }: { command: InstallCommand | null; onCommand: (command: InstallCommand | null) => void }) {
  const store = useAppStore();
  const port = useLocalExecutorPort();
  const pairing = usePairing();
  const accountId = useSession().data?.account?.accountId ?? null;
  // What the executor on this PC said: undefined while asking, null when nothing answered.
  const [probe, setProbe] = useState<LocalExecutorPairingState | null | undefined>(undefined);
  const [system, setSystem] = useState<InstallSystem | null>(null);
  const [busy, setBusy] = useState<'generate' | 'connect' | 'revoke' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Which question the employee is answering before an action goes ahead.
  const [asking, setAsking] = useState<'otherPc' | 'otherAccount' | 'reinstall' | 'revoke' | null>(null);
  const agreedSoFar = useRef<Agreed>({});
  const [copied, setCopied] = useState<boolean | null>(null);
  // Re-renders once a pending 配对码 reaches its expiry.
  const [, setTick] = useState(0);

  // One question to 47319 at a time. A slow answer (the browser asking the employee first) is kept when it comes.
  const live = useRef(true);
  const probing = useRef(false);
  const reprobe = useCallback(() => {
    if (probing.current) return;
    probing.current = true;
    void port.probe().then((state) => {
      probing.current = false;
      if (live.current) setProbe(state);
    });
  }, [port]);

  useEffect(() => {
    live.current = true;
    reprobe();
    const onFocus = () => reprobe();
    const onVisible = () => {
      if (document.visibilityState === 'visible') reprobe();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      live.current = false;
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [reprobe]);

  const view = pairing.data;
  const connected = view?.status === 'paired';
  const thisPcHolds = probe?.paired === true && probe.accountId === accountId;
  const waiting = view?.status === 'waiting' && unexpired(view.codeExpiresAt);
  const pending = command !== null && waiting && view.codeExpiresAt === command.expiresAt;

  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void store.loadPairing(), LOCAL_EXECUTOR_POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, store]);

  const expiresAt = waiting ? view.codeExpiresAt : null;
  useEffect(() => {
    if (!expiresAt) return;
    const timer = setTimeout(() => setTick((tick) => tick + 1), Math.max(0, Date.parse(expiresAt) - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [expiresAt]);

  // The command did its job once the executor holds the pairing.
  useEffect(() => {
    if (connected && command) onCommand(null);
  }, [connected, command, onCommand]);

  const generate = async (agreed: boolean) => {
    if (!system) return;
    if (!agreed && connected) {
      setAsking('reinstall');
      return;
    }
    setAsking(null);
    setBusy('generate');
    setError(null);
    setCopied(null);
    const outcome = await store.pairingAction((adapter) => adapter.createPairingCode({ system }));
    setBusy(null);
    if (!outcome.ok) {
      setError(outcome.error.message);
      return;
    }
    const code = outcome.pairing.code;
    onCommand(code ? { system, text: localExecutorInstallCommand(system, outcome.pairing.activeOrigin, code), expiresAt: outcome.pairing.codeExpiresAt } : null);
  };

  const connect = async (agreed: Agreed = {}) => {
    agreedSoFar.current = agreed;
    if (!agreed.otherPc && connected && !thisPcHolds) {
      setAsking('otherPc');
      return;
    }
    if (!agreed.otherAccount && probe?.paired && probe.accountId !== accountId) {
      setAsking('otherAccount');
      return;
    }
    setAsking(null);
    setBusy('connect');
    setError(null);
    const outcome = await store.pairingAction((adapter) => adapter.createPairingCode());
    const code = outcome.ok ? outcome.pairing.code : null;
    if (!outcome.ok || !code) {
      setBusy(null);
      setError(outcome.ok ? LOCAL_EXECUTOR_COPY.silent : outcome.error.message);
      return;
    }
    const answer = await port.pair(code);
    if (answer === null) {
      // Gone since it answered: back to the install command.
      setProbe(null);
      setBusy(null);
      setError(LOCAL_EXECUTOR_COPY.silent);
      return;
    }
    if (!answer.ok) {
      setBusy(null);
      setError(refusalSentence(answer));
      return;
    }
    setProbe({ paired: true, accountId: answer.accountId });
    await store.awaitPairingConnected();
    setBusy(null);
  };

  const agreeAndConnect = (more: Agreed) => void connect({ ...agreedSoFar.current, ...more });

  const revoke = async () => {
    setBusy('revoke');
    setError(null);
    const outcome = await store.pairingAction((adapter) => adapter.revokePairing());
    setBusy(null);
    if (!outcome.ok) {
      setError(outcome.error.message);
      return;
    }
    setAsking(null);
    // The executor here, if any, has just lost its pairing: ask it again.
    reprobe();
  };

  const answering = probe !== undefined && probe !== null;
  const offerConnect = answering && !(connected && thisPcHolds);
  const install = (
    <>
      <RadioButtonGroup legendText={LOCAL_EXECUTOR_COPY.system} name="local-executor-system" orientation="horizontal" valueSelected={system ?? ''} onChange={(value) => setSystem(value as InstallSystem)}>
        <RadioButton id="local-executor-system-mac" value="mac" labelText={LOCAL_EXECUTOR_COPY.systems.mac} />
        <RadioButton id="local-executor-system-windows" value="windows" labelText={LOCAL_EXECUTOR_COPY.systems.windows} />
      </RadioButtonGroup>
      <ActionGroup>
        <Button kind={command || connected ? 'secondary' : 'primary'} size="md" disabled={system === null || busy !== null} onClick={() => void generate(false)}>
          {LOCAL_EXECUTOR_COPY.generate}
        </Button>
      </ActionGroup>
      {command && pending ? (
        <div className="app-install-command" aria-label={LOCAL_EXECUTOR_COPY.command} role="group">
          <p>{LOCAL_EXECUTOR_COPY.pasteHint[command.system]}</p>
          <pre className="app-code app-select-all">{command.text}</pre>
          <ActionGroup
            caption={
              <span role="status" aria-live="polite">
                {copied === null ? LOCAL_EXECUTOR_COPY.codeHint : copied ? LOCAL_EXECUTOR_COPY.copied : LOCAL_EXECUTOR_COPY.copyByHand}
              </span>
            }
          >
            <Button kind="secondary" size="md" renderIcon={Copy} onClick={() => void copyText(command.text).then(setCopied)}>
              {LOCAL_EXECUTOR_COPY.copy}
            </Button>
          </ActionGroup>
          <p className="app-loading" role="status">
            {LOCAL_EXECUTOR_COPY.waiting}
          </p>
        </div>
      ) : null}
      {command && !pending && !connected ? <InlineNotification kind="warning" role="status" lowContrast hideCloseButton statusIconDescription="注意" title={LOCAL_EXECUTOR_COPY.expired} /> : null}
    </>
  );
  return (
    <section className="app-form-section" aria-label={LOCAL_EXECUTOR_COPY.title}>
      <h2 className="app-section-title">{LOCAL_EXECUTOR_COPY.title}</h2>
      <p>{LOCAL_EXECUTOR_COPY.lead}</p>
      {connected ? (
        <>
          <InlineNotification kind="success" role="status" lowContrast hideCloseButton statusIconDescription="成功" title={LOCAL_EXECUTOR_COPY.connected} subtitle={LOCAL_EXECUTOR_COPY.connectedLead} />
          <ActionGroup className="app-revoke-group">
            <Button kind="danger--tertiary" size="md" disabled={busy !== null} onClick={() => setAsking('revoke')}>
              {LOCAL_EXECUTOR_COPY.revoke}
            </Button>
          </ActionGroup>
        </>
      ) : null}
      {offerConnect ? (
        <>
          <p>{LOCAL_EXECUTOR_COPY.found}</p>
          {busy === 'connect' ? (
            <p className="app-loading" role="status">
              {LOCAL_EXECUTOR_COPY.connecting}
            </p>
          ) : null}
          <ActionGroup>
            <Button kind="primary" size="md" disabled={busy !== null} onClick={() => void connect()}>
              {LOCAL_EXECUTOR_COPY.connectHere}
            </Button>
          </ActionGroup>
        </>
      ) : null}
      {!answering && !connected ? install : null}
      {error && asking !== 'revoke' ? <InlineNotification kind="error" role="alert" lowContrast hideCloseButton statusIconDescription="错误" title={error} /> : null}
      <ErpCredentialsSection />
      <InstallTrouble>
        {connected ? (
          <>
            <h3>{LOCAL_EXECUTOR_COPY.reinstallTitle}</h3>
            <p>{LOCAL_EXECUTOR_COPY.reinstallLead}</p>
            {install}
          </>
        ) : null}
        <h3>{LOCAL_EXECUTOR_COPY.stepsTitle}</h3>
        <ol aria-label={LOCAL_EXECUTOR_COPY.stepsTitle}>
          {LOCAL_EXECUTOR_COPY.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <h3>{LOCAL_EXECUTOR_COPY.uninstallTitle}</h3>
        <p>{LOCAL_EXECUTOR_COPY.uninstallLead}</p>
        {view
          ? INSTALL_SYSTEMS.map((each) => (
              <div key={each} className="app-install-command" aria-label={`${LOCAL_EXECUTOR_COPY.uninstallCommand}（${LOCAL_EXECUTOR_COPY.systems[each]}）`} role="group">
                <p>{LOCAL_EXECUTOR_COPY.systems[each]}</p>
                <pre className="app-code app-select-all">{localExecutorUninstallCommand(each, view.activeOrigin)}</pre>
              </div>
            ))
          : null}
      </InstallTrouble>
      {asking === 'otherPc' ? (
        <ConfirmDialog title={LOCAL_EXECUTOR_COPY.otherPcTitle} confirmLabel={LOCAL_EXECUTOR_COPY.otherPcConfirm} busy={busy === 'connect'} onConfirm={() => agreeAndConnect({ otherPc: true })} onCancel={() => setAsking(null)}>
          <p>{LOCAL_EXECUTOR_COPY.otherPcBody}</p>
        </ConfirmDialog>
      ) : null}
      {asking === 'otherAccount' ? (
        <ConfirmDialog title={LOCAL_EXECUTOR_COPY.otherAccountTitle} confirmLabel={LOCAL_EXECUTOR_COPY.otherAccountConfirm} busy={busy === 'connect'} onConfirm={() => agreeAndConnect({ otherAccount: true })} onCancel={() => setAsking(null)}>
          <p>{LOCAL_EXECUTOR_COPY.otherAccountBody}</p>
        </ConfirmDialog>
      ) : null}
      {asking === 'reinstall' ? (
        <ConfirmDialog title={LOCAL_EXECUTOR_COPY.reinstallDialogTitle} confirmLabel={LOCAL_EXECUTOR_COPY.reinstallConfirm} busy={busy === 'generate'} onConfirm={() => void generate(true)} onCancel={() => setAsking(null)}>
          <p>{LOCAL_EXECUTOR_COPY.reinstallBody}</p>
        </ConfirmDialog>
      ) : null}
      {asking === 'revoke' ? (
        <ConfirmDialog
          danger
          title={LOCAL_EXECUTOR_COPY.revokeTitle}
          confirmLabel={LOCAL_EXECUTOR_COPY.revokeConfirm}
          busy={busy === 'revoke'}
          error={error}
          onConfirm={() => void revoke()}
          onCancel={() => {
            setAsking(null);
            setError(null);
          }}
        >
          <p>{LOCAL_EXECUTOR_COPY.revokeBody}</p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}

// 「安装遇到问题？」 (#429): the install help, collapsed by default so the section stays one sentence, one action and
// its 配对码.
function InstallTrouble({ children }: { children: ReactNode }) {
  return (
    <details className="app-install-trouble">
      <summary>{LOCAL_EXECUTOR_COPY.trouble}</summary>
      <div className="app-install-trouble-body">{children}</div>
    </details>
  );
}
