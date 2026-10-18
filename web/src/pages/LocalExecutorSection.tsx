import { useEffect, useState } from 'react';
import { Button, InlineNotification, RadioButton, RadioButtonGroup } from '@carbon/react';
import { Copy } from '@carbon/icons-react';
import { localExecutorInstallCommand, type InstallSystem, type LocalExecutorPairingState } from '@baox/contract';
import { useAppStore, useExtensionPairing, useLocalExecutorPort, useSession } from '../adapter/context';
import { ActionGroup } from '../shell/ActionGroup';
import { copyText } from '../shell/clipboard';
import { ConfirmDialog } from '../shell/Dialog';
import { endsOtherMethod, SwitchMethodDialog } from './reimburse-method';

// baox 本地执行器 (ADR-0033, ADR-0035 amended 2026-10-17): the program that does 去报销 on this PC in a browser nobody
// sees, instead of the 浏览器扩展. The employee picks Mac or Windows (neither is picked for them) and pastes the one
// command this section shows into Terminal or PowerShell; the 配对码 is inside it, and the script installs, pairs and
// starts the executor. While that code is pending this section reads the pairing again and again, and turns to 已连接
// by itself when the pairing lands.
//
// An executor already running on this PC answers on 47319 (`adapter/local-executor-port.ts`): then the section offers
// one click instead, which issues a code and hands it straight over. An executor paired to another 应用账号 is asked
// about first. An account has one pairing at a time, so pairing the executor replaces the extension's: with the
// extension paired, both actions ask first (`SwitchMethodDialog`, #428). 已连接 is the server's word: the pairing's
// holder is the 本地执行器.

export const LOCAL_EXECUTOR_COPY = {
  title: 'baox 本地执行器',
  lead: '在你的电脑后台替你去报销，不用打开浏览器扩展，也不占用你的浏览器窗口。装一次就行：以后每次登录电脑都会自动运行，应用发布新版本时它会自己更新。它会用电脑上已经装好的 Chrome 或 Edge。',
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
  connected: '已连接',
  connectedLead: '本地执行器已经连上这个账号，回到报销任务就可以去报销。',
  found: '这台电脑上已经装好了本地执行器，点一下就能把它连到这个账号，不用再打开终端。',
  connectHere: '连接这台电脑的执行器',
  connecting: '正在连接这台电脑的执行器…',
  silent: '这台电脑上的本地执行器没有应答。请用下面的安装命令再装一次。',
  otherAccountTitle: '换成这个账号',
  otherAccountBody: '这台电脑上的本地执行器正在替另一个应用账号去报销。连接后它改为替这个账号去报销，原来的账号就不能再用它了。',
  otherAccountConfirm: '换成这个账号',
  replaces: '一个账号同时只有一个配对：本地执行器配对后，原来配对的浏览器扩展会断开。',
} as const;

// How often the pairing is read again while an install command's code is pending.
export const LOCAL_EXECUTOR_POLL_MS = 1_500;

export function LocalExecutorSection() {
  const store = useAppStore();
  const port = useLocalExecutorPort();
  const pairing = useExtensionPairing();
  const accountId = useSession().data?.account?.accountId ?? null;
  // What the executor on this PC said: undefined while asking, null when nothing answered.
  const [probe, setProbe] = useState<LocalExecutorPairingState | null | undefined>(undefined);
  const [system, setSystem] = useState<InstallSystem | null>(null);
  const [command, setCommand] = useState<{ system: InstallSystem; text: string } | null>(null);
  // This section issued the code now pending, so it reads the pairing until that code lands.
  const [mine, setMine] = useState(false);
  const [busy, setBusy] = useState<'generate' | 'connect' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // Which action waits for the employee to agree to end the extension's pairing.
  const [switching, setSwitching] = useState<'generate' | 'connect' | null>(null);
  const [copied, setCopied] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;
    void port.probe().then((state) => {
      if (live) setProbe(state);
    });
    return () => {
      live = false;
    };
  }, [port]);

  const view = pairing.data;
  const connected = view?.status === 'paired' && view.holder === 'local_executor';
  const pending = mine && view?.status === 'waiting' && (!view.codeExpiresAt || Date.parse(view.codeExpiresAt) > Date.now());

  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void store.loadExtensionPairing(), LOCAL_EXECUTOR_POLL_MS);
    return () => clearInterval(timer);
  }, [pending, store]);

  const generate = async (agreed: boolean) => {
    if (!system) return;
    if (!agreed && endsOtherMethod(view, 'local_executor')) {
      setSwitching('generate');
      return;
    }
    setSwitching(null);
    setBusy('generate');
    setError(null);
    setCopied(null);
    const outcome = await store.extensionPairingAction((adapter) => adapter.createExtensionPairingCode({ system }));
    setBusy(null);
    if (!outcome.ok) {
      setError(outcome.error.message);
      return;
    }
    setMine(true);
    setCommand(outcome.pairing.code ? { system, text: localExecutorInstallCommand(system, outcome.pairing.activeOrigin, outcome.pairing.code) } : null);
  };

  // `switched`: the employee agreed to end the extension's pairing; `agreed`: to take the executor from another account.
  const connect = async (agreed: boolean, switched = false) => {
    if (!switched && endsOtherMethod(view, 'local_executor')) {
      setSwitching('connect');
      return;
    }
    setSwitching(null);
    if (!agreed && probe?.paired && probe.accountId !== accountId) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    setBusy('connect');
    setError(null);
    const outcome = await store.extensionPairingAction((adapter) => adapter.createExtensionPairingCode());
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
      setError(answer.message);
      return;
    }
    setMine(true);
    setProbe({ paired: true, accountId: answer.accountId });
    await store.awaitExtensionConnected();
    setBusy(null);
  };

  const answering = probe !== undefined && probe !== null;
  return (
    <section className="app-form-section" aria-label={LOCAL_EXECUTOR_COPY.title}>
      <h2 className="app-section-title">{LOCAL_EXECUTOR_COPY.title}</h2>
      <p>{LOCAL_EXECUTOR_COPY.lead}</p>
      {connected ? (
        <InlineNotification kind="success" role="status" lowContrast hideCloseButton statusIconDescription="成功" title={LOCAL_EXECUTOR_COPY.connected} subtitle={LOCAL_EXECUTOR_COPY.connectedLead} />
      ) : null}
      {answering && !connected ? (
        <>
          <p>{LOCAL_EXECUTOR_COPY.found}</p>
          {busy === 'connect' ? (
            <p className="app-loading" role="status">
              {LOCAL_EXECUTOR_COPY.connecting}
            </p>
          ) : null}
          <ActionGroup caption={LOCAL_EXECUTOR_COPY.replaces}>
            <Button kind="primary" size="md" disabled={busy !== null} onClick={() => void connect(false)}>
              {LOCAL_EXECUTOR_COPY.connectHere}
            </Button>
          </ActionGroup>
        </>
      ) : null}
      {!answering ? (
        <>
          <RadioButtonGroup legendText={LOCAL_EXECUTOR_COPY.system} name="local-executor-system" orientation="horizontal" valueSelected={system ?? ''} onChange={(value) => setSystem(value as InstallSystem)}>
            <RadioButton id="local-executor-system-mac" value="mac" labelText={LOCAL_EXECUTOR_COPY.systems.mac} />
            <RadioButton id="local-executor-system-windows" value="windows" labelText={LOCAL_EXECUTOR_COPY.systems.windows} />
          </RadioButtonGroup>
          <ActionGroup caption={LOCAL_EXECUTOR_COPY.replaces}>
            <Button kind={command ? 'secondary' : 'primary'} size="md" disabled={system === null || busy !== null} onClick={() => void generate(false)}>
              {LOCAL_EXECUTOR_COPY.generate}
            </Button>
          </ActionGroup>
          {command && !connected ? (
            <div className="app-install-command" aria-label={LOCAL_EXECUTOR_COPY.command} role="group">
              <p>{LOCAL_EXECUTOR_COPY.pasteHint[command.system]}</p>
              <pre className="app-code app-select-all">{command.text}</pre>
              <ActionGroup caption={copied === null ? LOCAL_EXECUTOR_COPY.codeHint : copied ? LOCAL_EXECUTOR_COPY.copied : LOCAL_EXECUTOR_COPY.copyByHand}>
                <Button kind="secondary" size="md" renderIcon={Copy} onClick={() => void copyText(command.text).then(setCopied)}>
                  {LOCAL_EXECUTOR_COPY.copy}
                </Button>
              </ActionGroup>
              {pending ? (
                <p className="app-loading" role="status">
                  {LOCAL_EXECUTOR_COPY.waiting}
                </p>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
      {error ? <InlineNotification kind="error" role="alert" lowContrast hideCloseButton statusIconDescription="错误" title={error} /> : null}
      {switching ? (
        <SwitchMethodDialog to="local_executor" onConfirm={() => void (switching === 'generate' ? generate(true) : connect(false, true))} onCancel={() => setSwitching(null)} />
      ) : null}
      {confirming ? (
        <ConfirmDialog
          title={LOCAL_EXECUTOR_COPY.otherAccountTitle}
          confirmLabel={LOCAL_EXECUTOR_COPY.otherAccountConfirm}
          busy={busy === 'connect'}
          onConfirm={() => void connect(true, true)}
          onCancel={() => setConfirming(false)}
        >
          <p>{LOCAL_EXECUTOR_COPY.otherAccountBody}</p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
