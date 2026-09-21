import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { EXTENSION_DOWNLOAD_PATH, EXTENSION_PAIRING_STATUS_LABELS, EXTENSION_VERSION, LEGACY_IMPORT_ERRORS, LEGACY_IMPORT_STATUS_LABELS } from '@baox/contract';
import { App } from '../App';
import { createMockAdapter } from '../mock/mock-adapter';
import type { LegacyOption } from '../mock/options';
import { EXTENSION_INSTALL_COPY } from './SettingsPage';

// 设置页的旧数据导入面板（故事 81）：损坏的旧数据要说清楚坏在哪个文件，并且能重试或明确跳过。
// 服务端的接口一直都在（#195），这里补的是它的界面。
// 设置页的浏览器扩展一节（#252）：员工在这里拿到配对码、看到配对了哪台浏览器与最近一次连接，并可以撤销配对。
// 配对码换长期凭据发生在扩展那一侧（服务端的 HTTP 缝里另有覆盖），这里只覆盖页面看得见的部分。
// 同一节还要让员工自己装上扩展（#258）：下载安装包，照着 Chrome、Edge 的步骤加载、升级，并事先知道调试提示条是怎么回事。
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
  test('还没有配对时给出生成配对码；生成后把那一串显示出来，并说明只显示这一次', async () => {
    renderPairing();
    await screen.findByText(EXTENSION_PAIRING_STATUS_LABELS.none);
    expect(within(extensionPanel()).queryByRole('button', { name: '撤销配对' })).toBeNull();

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
    // 配对了还不够：能不能去报销要看扩展这会儿连没连上。
    expect(within(extensionPanel()).getByText('已连接')).toBeTruthy();

    fireEvent.click(within(extensionPanel()).getByRole('button', { name: '撤销配对' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确定撤销' }));

    expect(await within(extensionPanel()).findByText(EXTENSION_PAIRING_STATUS_LABELS.none)).toBeTruthy();
    // 撤销配对不是退出登录：设置页照旧，没有回到登录门。
    expect(panel()).toBeTruthy();
  });
});

describe('设置页：浏览器扩展的下载、安装与升级', () => {
  test('从这一节下载安装包，并照着步骤在 Chrome 或 Edge 里加载、升级', async () => {
    renderPairing();
    await screen.findByText(EXTENSION_PAIRING_STATUS_LABELS.none);
    const section = within(extensionPanel());

    expect(section.getByRole('link', { name: EXTENSION_INSTALL_COPY.download }).getAttribute('href')).toBe(EXTENSION_DOWNLOAD_PATH);
    expect(section.getByText(`这里提供的扩展版本：${EXTENSION_VERSION}`)).toBeTruthy();

    // 两个浏览器的扩展管理页、开发者模式开关和加载按钮各叫什么，都照界面写出来。
    const install = section.getByRole('list', { name: '安装扩展' }).textContent ?? '';
    for (const words of ['chrome://extensions', 'edge://extensions', '开发者模式', '开发人员模式', '加载已解压的扩展程序', '加载解压缩的扩展', '配对码']) expect(install).toContain(words);
    const upgrade = section.getByRole('list', { name: '升级扩展' }).textContent ?? '';
    for (const words of ['下载浏览器扩展', '原来的文件夹', '重新加载']) expect(upgrade).toContain(words);
  });

  test('事先说明调试提示条是正常的，点它的取消会让这次去报销停下', async () => {
    renderPairing();
    await screen.findByText(EXTENSION_PAIRING_STATUS_LABELS.none);
    const section = within(extensionPanel());
    expect(section.getByText(/已开始调试此浏览器.*这是正常的/)).toBeTruthy();
    expect(section.getByText(/不要点这条提示上的“取消”.*这次去报销随即停止/)).toBeTruthy();
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
