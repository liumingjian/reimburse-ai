import { useState } from 'react';
import { Button, InlineNotification } from '@carbon/react';
import { Download } from '@carbon/icons-react';
import { LOCAL_EXECUTOR_DOWNLOAD_PATH, LOCAL_EXECUTOR_PLATFORM_LABELS, LOCAL_EXECUTOR_PLATFORMS } from '@baox/contract';
import { useAppStore, useExtensionPairing } from '../adapter/context';
import { ActionGroup } from '../shell/ActionGroup';

// baox 本地执行器 (ADR-0033, ADR-0035): the program that does 去报销 on this PC in a browser nobody sees, instead of the
// 浏览器扩展. Installed separately: one zip per system, unpacked and double-clicked once; it then starts with every
// login and keeps itself up to date from this server. It pairs with the account like the extension does, by a 配对码,
// and an account has one pairing at a time, so pairing it replaces the extension's.

export const LOCAL_EXECUTOR_COPY = {
  title: 'baox 本地执行器',
  lead: '在你的电脑后台替你去报销，不用打开浏览器扩展，也不占用你的浏览器窗口。安装一次就行：以后每次登录电脑都会自动运行，应用发布新版本时它会自己更新。它会用电脑上已经装好的 Chrome 或 Edge。',
  download: (label: string) => `下载（${label}）`,
  stepsTitle: '安装步骤',
  steps: [
    '按你的电脑下载对应的安装包，解压。',
    '点下面的「生成本地执行器配对码」。',
    'Windows：双击解压出来的 start-baox.cmd。如果出现「Windows 已保护你的电脑」，点「更多信息」，再点「仍要运行」。',
    'Mac：双击 start-baox.command。如果提示无法验证开发者，打开「系统设置」里的「隐私与安全性」，在下方点「仍要打开」，再双击一次。',
    '在弹出的窗口里输入配对码。看到「已安装」后就可以关掉窗口，回到报销任务去报销。',
  ],
  replaces: '一个账号同时只有一个配对：本地执行器配对后，原来配对的浏览器扩展会断开。',
  issue: '生成本地执行器配对码',
  code: '配对码',
  codeHint: '在本地执行器的窗口里输入这串字符。它只显示这一次，10 分钟内有效，用过就失效。',
} as const;

export function LocalExecutorSection() {
  const store = useAppStore();
  const pairing = useExtensionPairing();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The code is shown here only once this section issued it; the extension's section shows its own.
  const [issued, setIssued] = useState(false);

  const issue = async () => {
    setBusy(true);
    setError(null);
    const outcome = await store.extensionPairingAction((adapter) => adapter.createExtensionPairingCode());
    setBusy(false);
    if (!outcome.ok) setError(outcome.error.message);
    else setIssued(true);
  };

  const code = issued ? (pairing.data?.code ?? null) : null;
  return (
    <section className="app-form-section" aria-label={LOCAL_EXECUTOR_COPY.title}>
      <h2 className="app-section-title">{LOCAL_EXECUTOR_COPY.title}</h2>
      <p>{LOCAL_EXECUTOR_COPY.lead}</p>
      <ActionGroup>
        {LOCAL_EXECUTOR_PLATFORMS.map((platform) => (
          <Button key={platform} kind="secondary" size="md" href={`${LOCAL_EXECUTOR_DOWNLOAD_PATH}?platform=${platform}`} renderIcon={Download}>
            {LOCAL_EXECUTOR_COPY.download(LOCAL_EXECUTOR_PLATFORM_LABELS[platform])}
          </Button>
        ))}
      </ActionGroup>
      <h3>{LOCAL_EXECUTOR_COPY.stepsTitle}</h3>
      <ol aria-label={LOCAL_EXECUTOR_COPY.stepsTitle}>
        {LOCAL_EXECUTOR_COPY.steps.map((step) => <li key={step}>{step}</li>)}
      </ol>
      {code ? (
        <>
          <InlineNotification kind="success" role="status" lowContrast hideCloseButton statusIconDescription="成功" title={LOCAL_EXECUTOR_COPY.code} subtitle={code} />
          <p className="app-caption">{LOCAL_EXECUTOR_COPY.codeHint}</p>
        </>
      ) : null}
      <ActionGroup caption={LOCAL_EXECUTOR_COPY.replaces}>
        <Button kind="primary" size="md" disabled={busy} onClick={() => void issue()}>
          {LOCAL_EXECUTOR_COPY.issue}
        </Button>
      </ActionGroup>
      {error ? <InlineNotification kind="error" role="alert" lowContrast hideCloseButton statusIconDescription="错误" title={error} /> : null}
    </section>
  );
}
