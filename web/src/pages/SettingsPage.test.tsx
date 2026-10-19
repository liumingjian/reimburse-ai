import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { LEGACY_IMPORT_ERRORS, LEGACY_IMPORT_STATUS_LABELS, RESET_COPY } from '@baox/contract';
import { App } from '../App';
import { createMockAdapter, type MockOptions } from '../mock/mock-adapter';
import { SETTINGS_COPY } from './SettingsPage';
import { ERP_CREDENTIALS_COPY } from './ErpCredentialsSection';
import { LOCAL_EXECUTOR_COPY } from './LocalExecutorSection';

// 设置页的旧数据导入面板（故事 81）：损坏的旧数据要说清楚坏在哪个文件，并且能重试或明确跳过。
// 服务端的接口一直都在（#195），这里补的是它的界面。
// Since ADR-0037 the 本地执行器 is the only way to 去报销: the 设置页 shows its section and nothing to choose (#437).

// The 设置页 of an account with no 本地执行器 paired yet, unless `options` says otherwise.
function renderSettings(options: Partial<MockOptions> = {}) {
  window.location.hash = '#/settings';
  const adapter = createMockAdapter({ seed: 'actions', fault: null, pairing: 'none', localExecutorInstallMs: 60_000, ...options });
  render(<App adapter={adapter} localExecutor={adapter.localExecutor} />);
  return adapter;
}

const panel = () => screen.getByRole('region', { name: '旧数据导入' });

const localRegion = () => screen.getByRole('region', { name: LOCAL_EXECUTOR_COPY.title });

// The collapsed 「安装遇到问题？」 inside the 本地执行器 section (#429), and opening it the way the employee does.
function troubleArea(region: HTMLElement): HTMLDetailsElement {
  const details = within(region).getByText(LOCAL_EXECUTOR_COPY.trouble).closest('details');
  if (!details) throw new Error('「安装遇到问题？」 is not a details element');
  return details;
}
const openTrouble = (details: HTMLDetailsElement) => fireEvent.click(within(details).getByText(LOCAL_EXECUTOR_COPY.trouble));

describe('设置页：旧数据导入', () => {
  test('导入失败：逐个文件说明原因，并给出重试与跳过', async () => {
    renderSettings({ legacy: 'failed' });
    await screen.findByText(LEGACY_IMPORT_STATUS_LABELS.failed);
    const problems = within(panel()).getByRole('list', { name: '旧数据里的问题' });
    expect(within(problems).getByText('tasks/2026-05-10-b1b2c3d4e5/invoices.json')).toBeTruthy();
    expect(within(problems).getByText('home-cities.json')).toBeTruthy();
    expect(within(panel()).getByRole('button', { name: '重试导入' })).toBeTruthy();
    expect(within(panel()).getByRole('button', { name: '跳过导入' })).toBeTruthy();
  });

  test('修好之后重试：变成已导入，报告显示导进了什么，重试与跳过都收起', async () => {
    renderSettings({ legacy: 'failed' });
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
    renderSettings({ legacy: 'failed' });
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

describe('设置页：只有本地执行器', () => {
  test('没有「去报销的方式」可选，也没有浏览器扩展一节', async () => {
    renderSettings();
    expect(await screen.findByRole('region', { name: LOCAL_EXECUTOR_COPY.title })).toBeTruthy();
    expect(screen.queryByRole('group', { name: '去报销的方式' })).toBeNull();
    expect(screen.queryByRole('radio', { name: /浏览器扩展/ })).toBeNull();
    expect(screen.queryByRole('region', { name: '浏览器扩展' })).toBeNull();
    expect(document.body.textContent).not.toMatch(/扩展/);
  });

  test('本地执行器配对着：同样只有它这一节，显示已连接', async () => {
    renderSettings({ pairing: 'paired', localExecutor: 'paired' });
    expect(await within(await screen.findByRole('region', { name: LOCAL_EXECUTOR_COPY.title })).findByText(LOCAL_EXECUTOR_COPY.connected)).toBeTruthy();
    expect(screen.queryByRole('group', { name: '去报销的方式' })).toBeNull();
    expect(document.body.textContent).not.toMatch(/扩展/);
  });

  test('页头一句话说完整件事', async () => {
    renderSettings();
    expect(await screen.findByText(SETTINGS_COPY.lead)).toBeTruthy();
    expect(SETTINGS_COPY.lead).not.toMatch(/方式|扩展/);
    expect(SETTINGS_COPY.lead.match(/。/g)).toHaveLength(1);
  });

  test('报销系统账号表单在本地执行器一节里', async () => {
    renderSettings();
    const local = await screen.findByRole('region', { name: LOCAL_EXECUTOR_COPY.title });
    const form = within(local).getByRole('region', { name: ERP_CREDENTIALS_COPY.title });
    expect(await within(form).findByRole('button', { name: ERP_CREDENTIALS_COPY.save })).toBeTruthy();
    expect(screen.getAllByRole('region', { name: ERP_CREDENTIALS_COPY.title })).toHaveLength(1);
  });

  test('本地执行器一节只有一句话的说明', () => {
    expect(LOCAL_EXECUTOR_COPY.lead.match(/。/g)).toHaveLength(1);
  });

  test('本地执行器的「安装遇到问题？」默认收起，里面是安装步骤和 Mac、Windows 的卸载命令', async () => {
    const ORIGIN = 'http://10.250.0.222:8888';
    renderSettings();
    await screen.findByRole('region', { name: LOCAL_EXECUTOR_COPY.title });
    const details = troubleArea(localRegion());
    expect(details.open).toBe(false);
    openTrouble(details);
    expect(details.open).toBe(true);
    const steps = within(details).getByRole('list', { name: LOCAL_EXECUTOR_COPY.stepsTitle });
    expect(within(steps).getAllByRole('listitem')).toHaveLength(LOCAL_EXECUTOR_COPY.steps.length);
    expect(await within(details).findByText(`curl -fsSL ${ORIGIN}/uninstall/mac | sh`)).toBeTruthy();
    expect(within(details).getByText(`powershell -ExecutionPolicy Bypass -c "irm ${ORIGIN}/uninstall/windows | iex"`)).toBeTruthy();
    expect(within(details).getByText(LOCAL_EXECUTOR_COPY.uninstallLead)).toBeTruthy();
  });

  test('本地执行器已连接时，「安装遇到问题？」仍在，仍收起', async () => {
    renderSettings({ pairing: 'paired', localExecutor: 'paired' });
    await within(await screen.findByRole('region', { name: LOCAL_EXECUTOR_COPY.title })).findByText(LOCAL_EXECUTOR_COPY.connected);
    expect(troubleArea(localRegion()).open).toBe(false);
  });

  test('重置藏在高级设置里', async () => {
    renderSettings();
    await screen.findByRole('region', { name: LOCAL_EXECUTOR_COPY.title });
    const advanced = screen.getByText('高级设置').closest('details');
    expect(advanced?.open).toBe(false);
    fireEvent.click(screen.getByText('高级设置'));
    expect(await screen.findByRole('region', { name: RESET_COPY.title })).toBeTruthy();
    expect(advanced?.open).toBe(true);
  });

  test('从报销任务过来：可以返回原任务，返回不会自动开始去报销', async () => {
    window.location.hash = `#/settings?${new URLSearchParams({ returnTo: '#/task/T1/review' })}`;
    const adapter = createMockAdapter({ seed: 'actions', fault: null, pairing: 'none' });
    render(<App adapter={adapter} localExecutor={adapter.localExecutor} />);
    const back = within(await screen.findByRole('region', { name: '返回报销任务' })).getByRole('link', { name: '返回报销任务' });
    expect(back.getAttribute('href')).toBe('#/task/T1/review');
  });

  test('新文案说报销系统，不用破折号，不说重试，不提扩展', () => {
    const copy = JSON.stringify([LOCAL_EXECUTOR_COPY, SETTINGS_COPY]);
    expect(copy).not.toMatch(/ERP|Node|重试|扩展|[\u2013\u2014]/);
  });
});
