import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { EXTENSION_DOWNLOAD_PATH, EXTENSION_PAIRING_STATUS_LABELS, EXTENSION_VERSION, LEGACY_IMPORT_ERRORS, LEGACY_IMPORT_STATUS_LABELS, RESET_COPY } from '@baox/contract';
import { App } from '../App';
import { createMockAdapter } from '../mock/mock-adapter';
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

function renderPairing(paired = false) {
  window.location.hash = '#/settings';
  render(<App adapter={createMockAdapter({ seed: 'actions', fault: null, ...(paired ? { extensionPaired: true } : {}) })} />);
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
    expect(within(extensionPanel()).getByText(EXTENSION_PAIRING_COPY.firstTimeLead)).toBeTruthy();
    expect(within(extensionPanel()).queryByText(EXTENSION_PAIRING_COPY.disconnectedHint)).toBeNull();
    expect(within(extensionPanel()).queryByRole('button', { name: '撤销配对' })).toBeNull();
    expect(within(extensionPanel()).queryByRole('button', { name: '重新生成配对码' })).toBeNull();

    fireEvent.click(within(extensionPanel()).getByRole('button', { name: '生成配对码' }));
    expect(await within(extensionPanel()).findByText('K7MQ2PXD')).toBeTruthy();
    expect(within(extensionPanel()).getByText(EXTENSION_PAIRING_STATUS_LABELS.waiting)).toBeTruthy();
    expect(within(extensionPanel()).getByText('把这串字符填进扩展里。它只显示这一次，10 分钟内有效，用过就失效。')).toBeTruthy();
  });

  test('已配对时列出是哪台浏览器、扩展有没有连着与最近一次连接；撤销要先确认，而且不会退出登录', async () => {
    renderPairing(true);
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

  test('配对的扩展比这里提供的旧时，提醒按升级步骤换新', async () => {
    window.location.hash = '#/settings';
    const adapter = createMockAdapter({ seed: 'actions', fault: null, extensionPaired: true });
    const paired = await adapter.getExtensionPairing();
    render(<App adapter={{ ...adapter, getExtensionPairing: async () => ({ ...paired, version: '0.9.0' }) }} />);
    await screen.findByText(EXTENSION_PAIRING_STATUS_LABELS.paired);
    expect(within(extensionPanel()).getByText(EXTENSION_INSTALL_COPY.outdated('0.9.0', EXTENSION_VERSION))).toBeTruthy();
  });

  test('配对的扩展已是这一版时不提醒升级', async () => {
    renderPairing(true);
    await screen.findByText(EXTENSION_PAIRING_STATUS_LABELS.paired);
    expect(within(extensionPanel()).queryByText(/请按下面“升级扩展”的步骤/)).toBeNull();
  });
});
