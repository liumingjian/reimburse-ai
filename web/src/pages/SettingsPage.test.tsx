import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { EXTENSION_DOWNLOAD_PATH, EXTENSION_MINIMUM_VERSION, EXTENSION_PAIRING_STATUS_LABELS, EXTENSION_VERSION, LEGACY_IMPORT_ERRORS, LEGACY_IMPORT_STATUS_LABELS, RESET_COPY, type AppAdapter, type ExtensionPairOutcome, type ExtensionSwitchOutcome } from '@baox/contract';
import { App } from '../App';
import type { ExtensionBridge, ExtensionPresence } from '../adapter/extension-bridge';
import { MOCK_ACCOUNT } from '../mock/auth';
import { createMockAdapter } from '../mock/mock-adapter';
import { extensionSettingsHash } from '../router';
import { EXTENSION_TUTORIAL_COPY } from './ExtensionTutorialPage';
import type { LegacyOption } from '../mock/options';
import { EXTENSION_INSTALL_COPY, EXTENSION_PAIRING_COPY } from './SettingsPage';

// 设置页的旧数据导入面板（故事 81）：损坏的旧数据要说清楚坏在哪个文件，并且能重试或明确跳过。
// 服务端的接口一直都在（#195），这里补的是它的界面。
// The settings page's 浏览器扩展 (browser extension) section (#252): the employee gets a 配对码 (pairing code) here, sees
// which browser is paired and when it last connected, and can revoke the pairing. Exchanging the 配对码 for the
// credential happens on the extension's side (covered at the server's HTTP seam); this covers only what the page shows.
// The same section lets the employee install the extension (#258): download the package, load and upgrade it by the
// Chrome and Edge steps, and know in advance what the debugging banner is.
// 安装包里带的地址与版本由服务端的 HTTP 缝检查（server/src/extension/download.test.ts）。

function renderSettings(legacy?: LegacyOption) {
  window.location.hash = '#/settings';
  const adapter = createMockAdapter({ seed: 'actions', fault: null, ...(legacy ? { legacy } : {}) });
  render(<App adapter={adapter} />);
  return adapter;
}

const panel = () => screen.getByRole('region', { name: '旧数据导入' });

type PairingOptions = { paired?: boolean; connected?: boolean; origin?: string };

function renderPairing({ paired = false, connected = true, origin }: PairingOptions = {}) {
  window.location.hash = '#/settings';
  render(
    <App
      adapter={createMockAdapter({
        seed: 'actions',
        fault: null,
        ...(paired ? { extensionPaired: true, extensionConnected: connected } : {}),
        ...(origin ? { extensionOrigin: origin } : {}),
      })}
    />,
  );
}

function renderTutorial() {
  window.location.hash = '#/settings/tutorial';
  render(<App adapter={createMockAdapter({ seed: 'actions', fault: null })} />);
}

const extensionPanel = () => screen.getByRole('region', { name: '浏览器扩展' });

describe('设置页：旧数据导入', () => {
  test('导入失败：逐个文件说明原因，并给出重试与跳过', async () => {
    renderSettings('failed');
    await screen.findByText(LEGACY_IMPORT_STATUS_LABELS.failed);
    const problems = within(panel()).getByRole('list', { name: '旧数据里的问题' });
    expect(within(problems).getByText('tasks/2026-05-10-b1b2c3d4e5/invoices.json')).toBeTruthy();
    expect(within(problems).getByText('home-cities.json')).toBeTruthy();
    expect(within(panel()).getByRole('button', { name: '重试导入' })).toBeTruthy();
    expect(within(panel()).getByRole('button', { name: '跳过导入' })).toBeTruthy();
  });

  test('修好之后重试：变成已导入，报告显示导进了什么，重试与跳过都收起', async () => {
    renderSettings('failed');
    fireEvent.click(await screen.findByRole('button', { name: '重试导入' }));

    expect(await screen.findByText(LEGACY_IMPORT_STATUS_LABELS.imported)).toBeTruthy();
    expect(within(panel()).getByText('2 个项目')).toBeTruthy();
    expect(within(panel()).getByText('3 张发票')).toBeTruthy();
    // 没有动过报销系统的旧任务不迁移，它们的发票仍然空闲。
    expect(within(within(panel()).getByRole('list', { name: '没有迁移的旧任务' })).getByText('六月未提交')).toBeTruthy();
    expect(within(panel()).queryByRole('button', { name: '重试导入' })).toBeNull();
    expect(within(panel()).queryByRole('button', { name: '跳过导入' })).toBeNull();
  });

  test('明确跳过：记为已跳过，之后不再提供重试', async () => {
    renderSettings('failed');
    fireEvent.click(await screen.findByRole('button', { name: '跳过导入' }));

    expect(await screen.findByText(LEGACY_IMPORT_STATUS_LABELS.skipped)).toBeTruthy();
    expect(within(panel()).queryByRole('button', { name: '重试导入' })).toBeNull();
  });

  test('没有待处理的那一次：只显示结果，不给重试或跳过；服务端拒绝时原因就地显示', async () => {
    const adapter = renderSettings();
    expect(await screen.findByText(LEGACY_IMPORT_STATUS_LABELS.none)).toBeTruthy();
    expect(within(panel()).queryByRole('button', { name: '重试导入' })).toBeNull();
    // 直接调接口也会被拒绝，和服务端同一个错误码。
    expect(await adapter.retryLegacyImport()).toMatchObject({ ok: false, error: { code: 'import_not_pending', message: LEGACY_IMPORT_ERRORS.notPending } });
  });
});

describe('设置页：浏览器扩展', () => {
  test('还没有配对时给出第一次连接指导；生成后把那一串显示出来，并说明只显示这一次', async () => {
    renderPairing();
    await screen.findByText(EXTENSION_PAIRING_STATUS_LABELS.none);
    expect(within(extensionPanel()).getByText(EXTENSION_PAIRING_COPY.firstTimeTitle)).toBeTruthy();
    expect(within(extensionPanel()).getByText(EXTENSION_PAIRING_COPY.firstTimeLead('http://10.250.0.222:8888'))).toBeTruthy();
    expect(within(extensionPanel()).getByText('http://10.250.0.222:8888')).toBeTruthy();
    expect(within(extensionPanel()).queryByText(EXTENSION_PAIRING_COPY.migrationTitle)).toBeNull();
    expect(within(extensionPanel()).queryByRole('button', { name: '撤销配对' })).toBeNull();
    expect(within(extensionPanel()).queryByRole('button', { name: '重新生成配对码' })).toBeNull();

    fireEvent.click(within(extensionPanel()).getByRole('button', { name: '生成配对码' }));
    expect(await within(extensionPanel()).findByText('K7MQ2PXD')).toBeTruthy();
    expect(within(extensionPanel()).getByText(EXTENSION_PAIRING_STATUS_LABELS.waiting)).toBeTruthy();
    expect(within(extensionPanel()).getByText('把这串字符填进扩展里。它只显示这一次，10 分钟内有效，用过就失效。')).toBeTruthy();
  });

  test('已配对时列出是哪台浏览器、扩展有没有连着与最近一次连接；撤销要先确认，而且不会退出登录', async () => {
    renderPairing({ paired: true });
    await screen.findByText(EXTENSION_PAIRING_STATUS_LABELS.paired);
    expect(within(extensionPanel()).getByText('Chrome 142 · Windows 11')).toBeTruthy();
    expect(within(extensionPanel()).getByText('2026-02-03T14:20:00Z')).toBeTruthy();
    // Paired is not enough: whether 去报销 can run depends on the extension being connected right now.
    expect(within(extensionPanel()).getByText('已连接')).toBeTruthy();

    fireEvent.click(within(extensionPanel()).getByRole('button', { name: '撤销配对' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确定撤销' }));

    expect(await within(extensionPanel()).findByText(EXTENSION_PAIRING_STATUS_LABELS.none)).toBeTruthy();
    // 撤销配对 is not a logout: the settings page stays, with no return to the sign-in gate.
    expect(panel()).toBeTruthy();
  });

  test('已配对但没有连接时，按当前应用地址引导下载、替换、重新加载和重新配对', async () => {
    const origin = 'https://baox.example.com:9443';
    renderPairing({ paired: true, connected: false, origin });

    await screen.findByText(EXTENSION_PAIRING_STATUS_LABELS.paired);
    const section = within(extensionPanel());
    expect(section.getByText(origin)).toBeTruthy();
    expect(section.getByText(EXTENSION_PAIRING_COPY.disconnectedLead(origin))).toBeTruthy();
    expect(section.getByText(EXTENSION_PAIRING_COPY.migrationLead(origin))).toBeTruthy();
    const steps = section.getByRole('list', { name: EXTENSION_PAIRING_COPY.migrationTitle });
    expect(within(steps).getByText(EXTENSION_PAIRING_COPY.migrationDownload(origin))).toBeTruthy();
    expect(within(steps).getByText(EXTENSION_PAIRING_COPY.migrationReplace)).toBeTruthy();
    expect(within(steps).getByText(EXTENSION_PAIRING_COPY.migrationPair)).toBeTruthy();
    expect(within(steps).getByText(EXTENSION_PAIRING_COPY.migrationVerify)).toBeTruthy();
    expect(section.getByText(EXTENSION_PAIRING_COPY.migrationOldPair(origin))).toBeTruthy();
    expect(section.getByRole('link', { name: EXTENSION_PAIRING_COPY.download }).getAttribute('href')).toBe(EXTENSION_DOWNLOAD_PATH);
    expect(section.getByRole('button', { name: EXTENSION_PAIRING_COPY.reconnect })).toBeTruthy();
  });

  test('重置藏在高级设置里，第一次连接时不会和恢复操作混在一起', async () => {
    renderPairing();
    await screen.findByText(EXTENSION_PAIRING_STATUS_LABELS.none);
    const advanced = screen.getByText('高级设置').closest('details');
    expect(advanced?.open).toBe(false);
    expect(screen.getByRole('button', { name: RESET_COPY.button })).toBeTruthy();

    fireEvent.click(screen.getByText('高级设置'));
    expect(await screen.findByRole('region', { name: RESET_COPY.title })).toBeTruthy();
    expect(advanced?.open).toBe(true);
    expect(screen.getByRole('button', { name: RESET_COPY.button })).toBeTruthy();
  });
});

describe('设置页：浏览器扩展的下载、安装与升级', () => {
  test('常规设置只保留下载入口和独立教程入口', async () => {
    renderPairing();
    await screen.findByText(EXTENSION_PAIRING_STATUS_LABELS.none);
    const section = within(extensionPanel());

    expect(section.getByRole('link', { name: EXTENSION_INSTALL_COPY.download }).getAttribute('href')).toBe(EXTENSION_DOWNLOAD_PATH);
    const tutorial = section.getByRole('link', { name: EXTENSION_PAIRING_COPY.tutorial });
    expect(tutorial.getAttribute('href')).toBe('#/settings/tutorial');
    expect(tutorial.getAttribute('target')).toBe('_blank');
    expect(section.queryByRole('list', { name: '安装扩展' })).toBeNull();
  });

  test('独立教程显示图示、安装步骤和调试提示条说明', async () => {
    renderTutorial();
    expect(await screen.findByRole('heading', { level: 1, name: '浏览器扩展安装教程' })).toBeTruthy();
    expect(screen.getByRole('img', { name: '浏览器扩展安装示意图' })).toBeTruthy();
    expect(screen.getByText(EXTENSION_INSTALL_COPY.offeredVersion(EXTENSION_VERSION))).toBeTruthy();
    const install = screen.getByRole('list', { name: '安装步骤' }).textContent ?? '';
    for (const words of ['chrome://extensions', 'edge://extensions', '开发者模式', '开发人员模式', '加载已解压的扩展程序', '加载解压缩的扩展', '配对码']) expect(install).toContain(words);
    expect(screen.getByRole('region', { name: '去报销时浏览器顶部的提示条' })).toBeTruthy();
    // #257: a Cancel between two steps resumes in the same tab; one in the middle of a write goes to 对账.
    expect(screen.getByText(/不要点这条提示上的“取消”.*同一个标签页.*接着做下去.*转去对账/)).toBeTruthy();
  });

  test('独立教程的升级步骤只有下载、覆盖原来的文件夹、重新加载，不要求重新配对', async () => {
    renderTutorial();
    const upgrade = (await screen.findByRole('list', { name: '升级扩展' })).textContent ?? '';
    for (const words of ['下载浏览器扩展', '原来的文件夹', '重新加载']) expect(upgrade).toContain(words);
    expect(upgrade).not.toContain('配对');
    expect(EXTENSION_INSTALL_COPY.upgradeLead).not.toContain('配对');
  });

  test('配对的扩展比这里提供的旧时，提醒按升级步骤换新', async () => {
    window.location.hash = '#/settings';
    const adapter = createMockAdapter({ seed: 'actions', fault: null, extensionPaired: true });
    const paired = await adapter.getExtensionPairing();
    render(<App adapter={{ ...adapter, getExtensionPairing: async () => ({ ...paired, version: '0.9.0' }) }} />);
    await screen.findByText(EXTENSION_PAIRING_STATUS_LABELS.paired);
    const notice = within(extensionPanel()).getByText(EXTENSION_INSTALL_COPY.outdated('0.9.0', EXTENSION_VERSION));
    expect(notice).toBeTruthy();
    expect(notice.textContent).not.toContain('配对');
  });

  test('配对的扩展已是这一版时不提醒升级', async () => {
    renderPairing({ paired: true });
    await screen.findByText(EXTENSION_PAIRING_STATUS_LABELS.paired);
    expect(within(extensionPanel()).queryByText(/请按下面“升级扩展”的步骤/)).toBeNull();
  });
});

// Answers every probe with what `presence` returns at that moment, every switch request with what `switchTo` resolves
// to, and every pair request with what `pair` returns; null is silence. Records the 配对码 handed over and the
// accounts a switch was asked for.
function fakeBridge(
  presence: () => ExtensionPresence | null,
  pair: (code: string) => ExtensionPairOutcome | null = () => null,
  switchTo: () => Promise<ExtensionSwitchOutcome | null> = async () => null,
): ExtensionBridge & { probes: () => number; codes: string[]; switches: string[] } {
  let probes = 0;
  const codes: string[] = [];
  const switches: string[] = [];
  return {
    probe: async () => {
      probes += 1;
      return presence();
    },
    switchTo: async (accountId) => {
      switches.push(accountId);
      return switchTo();
    },
    pair: async (code) => {
      codes.push(code);
      return pair(code);
    },
    probes: () => probes,
    codes,
    switches,
  };
}

// After a one-click pairing the page renders once more with the step from before it (the manual flow, now beside the
// server's 已连接) until the re-probe answers, so wait for the connection-only view rather than for its title.
async function settledPairedHere(section: ReturnType<typeof within>) {
  await waitFor(() => {
    expect(section.getByText(EXTENSION_PAIRING_COPY.connectedTitle)).toBeTruthy();
    expect(section.queryByRole('link', { name: EXTENSION_PAIRING_COPY.tutorial })).toBeNull();
  });
}

// #290: the page asks the extension in this browser who it is (a fake bridge here; the real one is
// adapter/extension-bridge.ts) and shows only the step the employee is on.
describe('设置页：按这台浏览器里的扩展只显示当前这一步', () => {
  function renderWithExtension(bridge: ExtensionBridge, { paired = false, hash = '#/settings' }: { paired?: boolean; hash?: string } = {}) {
    window.location.hash = hash;
    render(<App adapter={createMockAdapter({ seed: 'actions', fault: null, ...(paired ? { extensionPaired: true } : {}) })} bridge={bridge} />);
  }

  const mine = (version = EXTENSION_VERSION): ExtensionPresence => ({ version, paired: true, accountId: MOCK_ACCOUNT.accountId });

  test('没有扩展应答：安装步骤和手动配对码，和以前一样', async () => {
    renderWithExtension(fakeBridge(() => null));
    const section = within(await screen.findByRole('region', { name: '浏览器扩展' }));
    expect(await section.findByText(EXTENSION_PAIRING_COPY.firstTimeTitle)).toBeTruthy();
    expect(section.getByRole('button', { name: '生成配对码' })).toBeTruthy();
    expect(section.getByRole('link', { name: EXTENSION_PAIRING_COPY.tutorial })).toBeTruthy();
    expect(section.getByRole('link', { name: EXTENSION_PAIRING_COPY.download }).getAttribute('href')).toBe(EXTENSION_DOWNLOAD_PATH);
  });

  test('扩展比这个应用要求的旧：说出装的版本和要求的版本，只给升级步骤', async () => {
    renderWithExtension(fakeBridge(() => ({ version: '1.0.0', paired: false, accountId: null })));
    const section = within(await screen.findByRole('region', { name: '浏览器扩展' }));
    expect(await section.findByText(EXTENSION_INSTALL_COPY.tooOld('1.0.0', EXTENSION_MINIMUM_VERSION))).toBeTruthy();
    const steps = section.getByRole('list', { name: EXTENSION_INSTALL_COPY.upgradeTitle });
    expect(within(steps).getAllByRole('listitem')).toHaveLength(EXTENSION_INSTALL_COPY.upgradeSteps.length);
    expect(steps.textContent).not.toContain('配对');
    expect(section.getByRole('link', { name: EXTENSION_PAIRING_COPY.download }).getAttribute('href')).toBe(EXTENSION_DOWNLOAD_PATH);
    expect(section.queryByRole('button', { name: '生成配对码' })).toBeNull();
    expect(section.queryByRole('link', { name: EXTENSION_PAIRING_COPY.tutorial })).toBeNull();
    expect(section.queryByText(EXTENSION_PAIRING_COPY.firstTimeTitle)).toBeNull();
  });

  test('已经和这个账号配对：不显示教程，只显示连接状态', async () => {
    renderWithExtension(fakeBridge(() => mine()), { paired: true });
    const section = within(await screen.findByRole('region', { name: '浏览器扩展' }));
    expect(await section.findByText(EXTENSION_PAIRING_COPY.connectedTitle)).toBeTruthy();
    expect(section.getByText('已连接')).toBeTruthy();
    expect(section.queryByRole('link', { name: EXTENSION_PAIRING_COPY.tutorial })).toBeNull();
    expect(section.queryByRole('link', { name: EXTENSION_PAIRING_COPY.download })).toBeNull();
    expect(section.queryByRole('button', { name: '重新生成配对码' })).toBeNull();
    expect(section.getByRole('button', { name: '撤销配对' })).toBeTruthy();
  });

  test('扩展配对的是另一个账号、也没回答能不能换：走手动配对码，不自动生成', async () => {
    const bridge = fakeBridge(() => ({ version: EXTENSION_VERSION, paired: true, accountId: 'someone-else' }));
    renderWithExtension(bridge);
    const section = within(await screen.findByRole('region', { name: '浏览器扩展' }));
    expect(await section.findByText(EXTENSION_PAIRING_COPY.firstTimeTitle)).toBeTruthy();
    expect(section.getByRole('button', { name: '生成配对码' })).toBeTruthy();
    expect(bridge.switches).toEqual([MOCK_ACCOUNT.accountId]);
    expect(bridge.codes).toEqual([]);
    expect(section.getByText(EXTENSION_PAIRING_STATUS_LABELS.none)).toBeTruthy();
  });

  test('撤销配对之后再问一次扩展，不会留着过时的已连接', async () => {
    let paired = true;
    const bridge = fakeBridge(() => (paired ? mine() : { version: EXTENSION_VERSION, paired: false, accountId: null }));
    renderWithExtension(bridge, { paired: true });
    const section = within(await screen.findByRole('region', { name: '浏览器扩展' }));
    expect(await section.findByText(EXTENSION_PAIRING_COPY.connectedTitle)).toBeTruthy();
    const before = bridge.probes();

    // The extension, told by the server, answers unpaired from now on.
    paired = false;
    fireEvent.click(section.getByRole('button', { name: '撤销配对' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确定撤销' }));

    expect(await section.findByText(EXTENSION_PAIRING_COPY.firstTimeTitle)).toBeTruthy();
    expect(bridge.probes()).toBeGreaterThan(before);
    expect(section.queryByText(EXTENSION_PAIRING_COPY.connectedTitle)).toBeNull();
    expect(section.getByText(EXTENSION_PAIRING_STATUS_LABELS.none)).toBeTruthy();
  });

  test('独立教程也跟着走：扩展太旧只给升级步骤，已配对不给安装步骤', async () => {
    renderWithExtension(fakeBridge(() => ({ version: '1.0.0', paired: false, accountId: null })), { hash: '#/settings/tutorial' });
    expect(await screen.findByText(EXTENSION_INSTALL_COPY.tooOld('1.0.0', EXTENSION_MINIMUM_VERSION))).toBeTruthy();
    expect(screen.getByRole('list', { name: '升级扩展' })).toBeTruthy();
    expect(screen.queryByRole('list', { name: '安装步骤' })).toBeNull();
    cleanup();

    renderWithExtension(fakeBridge(() => mine()), { paired: true, hash: '#/settings/tutorial' });
    expect(await screen.findByText(EXTENSION_TUTORIAL_COPY.pairedHere)).toBeTruthy();
    expect(screen.queryByRole('list', { name: '安装步骤' })).toBeNull();
    expect(screen.queryByRole('list', { name: '升级扩展' })).toBeNull();
  });
});

// #291: an extension that answers but is not paired to this account is handed a freshly issued 配对码 and redeems it;
// the employee types nothing. The mock server has no extension to redeem the code, so the adapter here plays the
// server's side once the fake bridge has "redeemed" it.
describe('设置页：扩展应答但没有配对时一键配对', () => {
  const unpaired: ExtensionPresence = { version: EXTENSION_VERSION, paired: false, accountId: null };
  const mine: ExtensionPresence = { version: EXTENSION_VERSION, paired: true, accountId: MOCK_ACCOUNT.accountId };

  type Redeem = (code: string) => ExtensionPairOutcome | null;
  type Before = { presence?: ExtensionPresence; switchTo?: () => Promise<ExtensionSwitchOutcome | null> };

  async function renderAutoPair(redeem: Redeem, hash = '#/settings', { presence = unpaired, switchTo }: Before = {}) {
    const pairedView = await createMockAdapter({ seed: 'actions', fault: null, extensionPaired: true }).getExtensionPairing();
    const adapter = createMockAdapter({ seed: 'actions', fault: null });
    let redeemed = false;
    const issued: number[] = [];
    const server: AppAdapter = {
      ...adapter,
      getExtensionPairing: async () => (redeemed ? pairedView : adapter.getExtensionPairing()),
      createExtensionPairingCode: async () => {
        issued.push(1);
        return adapter.createExtensionPairingCode();
      },
    };
    const bridge = fakeBridge(
      () => (redeemed ? mine : presence),
      (code) => {
        const outcome = redeem(code);
        redeemed = outcome?.status === 'paired';
        return outcome;
      },
      switchTo,
    );
    window.location.hash = hash;
    render(<App adapter={server} bridge={bridge} />);
    return { bridge, issued, section: within(await screen.findByRole('region', { name: '浏览器扩展' })) };
  }

  test('没有配对：自动生成配对码交给扩展，到已连接，不用输入', async () => {
    const { bridge, issued, section } = await renderAutoPair(() => ({ status: 'paired', accountId: MOCK_ACCOUNT.accountId }));
    await settledPairedHere(section);
    expect(section.getByText('已连接')).toBeTruthy();
    expect(bridge.codes).toEqual(['K7MQ2PXD']);
    expect(bridge.switches).toEqual([]);
    expect(issued).toHaveLength(1);
    expect(section.queryByText('K7MQ2PXD')).toBeNull();
    expect(section.queryByText(EXTENSION_PAIRING_COPY.firstTimeTitle)).toBeNull();
    expect(section.queryByRole('link', { name: EXTENSION_PAIRING_COPY.tutorial })).toBeNull();
  });

  test('扩展配对失败：说出扩展给的原因，仍可手动输入配对码', async () => {
    const message = '配对码不对，或者已经过期、已经用过。请在设置页重新生成一个。';
    const { issued, section } = await renderAutoPair(() => ({ status: 'failed', code: 'code_invalid', message }));
    expect(await section.findByText(message)).toBeTruthy();
    expect(section.getByText(EXTENSION_PAIRING_COPY.autoPairFailed)).toBeTruthy();
    expect(section.getByText('K7MQ2PXD')).toBeTruthy();
    expect(section.getByRole('button', { name: '重新生成配对码' })).toBeTruthy();
    expect(issued).toHaveLength(1);
  });

  test('扩展没有应答：退回手动流程，显示配对码让员工填进扩展', async () => {
    const { section } = await renderAutoPair(() => null);
    expect(await section.findByText('K7MQ2PXD')).toBeTruthy();
    expect(section.getByText(EXTENSION_PAIRING_COPY.autoPairSilent)).toBeTruthy();
    expect(section.getByText(EXTENSION_PAIRING_COPY.waitingTitle)).toBeTruthy();
    expect(section.getByText(EXTENSION_PAIRING_COPY.codeHint)).toBeTruthy();
  });

  test('从报销任务过来：自动配对之后仍能返回原任务', async () => {
    const returnTo = '#/task/t-1/review';
    const { section } = await renderAutoPair(() => ({ status: 'paired', accountId: MOCK_ACCOUNT.accountId }), extensionSettingsHash('t-1', 'review'));
    expect(await section.findByText(EXTENSION_PAIRING_COPY.connectedTitle)).toBeTruthy();
    const back = within(screen.getByRole('region', { name: '返回报销任务' })).getByRole('link', { name: '返回报销任务' });
    expect(back.getAttribute('href')).toBe(`${returnTo}?extensionSetup=1`);
  });

  test('没有扩展应答探测时不生成配对码', async () => {
    const adapter = createMockAdapter({ seed: 'actions', fault: null });
    let issued = 0;
    window.location.hash = '#/settings';
    render(<App adapter={{ ...adapter, createExtensionPairingCode: async () => { issued += 1; return adapter.createExtensionPairingCode(); } }} bridge={fakeBridge(() => null)} />);
    const section = within(await screen.findByRole('region', { name: '浏览器扩展' }));
    expect(await section.findByText(EXTENSION_PAIRING_COPY.firstTimeTitle)).toBeTruthy();
    expect(issued).toBe(0);
  });
});

// #292: an extension acting for another 应用账号 asks the employee, in a window of its own, before it switches. The
// page asks it first and issues a 配对码 only after a yes, because issuing one ends this account's earlier pairing.
describe('设置页：扩展在替另一个账号报销时，先由扩展问员工要不要换', () => {
  const colleague: ExtensionPresence = { version: EXTENSION_VERSION, paired: true, accountId: 'someone-else' };
  const mine: ExtensionPresence = { version: EXTENSION_VERSION, paired: true, accountId: MOCK_ACCOUNT.accountId };

  function renderSwitch(switchTo: () => Promise<ExtensionSwitchOutcome | null>) {
    const pairedView = createMockAdapter({ seed: 'actions', fault: null, extensionPaired: true }).getExtensionPairing();
    const adapter = createMockAdapter({ seed: 'actions', fault: null });
    let redeemed = false;
    const issued: number[] = [];
    const server: AppAdapter = {
      ...adapter,
      getExtensionPairing: async () => (redeemed ? pairedView : adapter.getExtensionPairing()),
      createExtensionPairingCode: async () => {
        issued.push(1);
        return adapter.createExtensionPairingCode();
      },
    };
    const bridge = fakeBridge(
      () => (redeemed ? mine : colleague),
      () => {
        redeemed = true;
        return { status: 'paired', accountId: MOCK_ACCOUNT.accountId };
      },
      switchTo,
    );
    window.location.hash = '#/settings';
    render(<App adapter={server} bridge={bridge} />);
    return { bridge, issued };
  }

  test('员工同意换：配对码只在同意之后生成，交给扩展，到已连接', async () => {
    const { bridge, issued } = renderSwitch(async () => 'accepted');
    const section = within(await screen.findByRole('region', { name: '浏览器扩展' }));
    await settledPairedHere(section);
    expect(section.getByText('已连接')).toBeTruthy();
    expect(bridge.switches).toEqual([MOCK_ACCOUNT.accountId]);
    expect(bridge.codes).toEqual(['K7MQ2PXD']);
    expect(issued).toHaveLength(1);
  });

  test('员工不同意：不生成配对码，说明扩展仍在替另一个账号报销，手动流程还在', async () => {
    const { bridge, issued } = renderSwitch(async () => 'declined');
    const section = within(await screen.findByRole('region', { name: '浏览器扩展' }));
    expect(await section.findByText(EXTENSION_PAIRING_COPY.autoPairDeclinedTitle)).toBeTruthy();
    expect(section.getByText(EXTENSION_PAIRING_COPY.autoPairDeclined)).toBeTruthy();
    expect(section.getByRole('button', { name: '生成配对码' })).toBeTruthy();
    expect(section.getByText(EXTENSION_PAIRING_STATUS_LABELS.none)).toBeTruthy();
    expect(bridge.codes).toEqual([]);
    expect(issued).toHaveLength(0);
  });

  test('员工还在看扩展的问题：页面等着，不生成配对码', async () => {
    const { bridge, issued } = renderSwitch(() => new Promise(() => undefined));
    const section = within(await screen.findByRole('region', { name: '浏览器扩展' }));
    expect(await section.findByText(EXTENSION_PAIRING_COPY.autoPairConfirming)).toBeTruthy();
    expect(section.queryByRole('button', { name: '生成配对码' })).toBeNull();
    expect(bridge.codes).toEqual([]);
    expect(issued).toHaveLength(0);
  });
});
