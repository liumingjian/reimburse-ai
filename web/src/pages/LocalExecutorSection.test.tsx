import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { App } from '../App';
import { createMockAdapter, type MockOptions } from '../mock/mock-adapter';
import { LOCAL_EXECUTOR_COPY } from './LocalExecutorSection';

// 设置页的 baox 本地执行器一节（spec #412 C，ADR-0035）：选 Mac 或 Windows，生成一条安装命令贴进终端；装好后这一节
// 自己变成已连接。这台电脑上已经有执行器在 47319 应答时，改成一键「连接这台电脑的执行器」。
// 安装命令背后的脚本由服务端的 HTTP 缝检查（server/src/local-executor/install.test.ts）。

// navigator.clipboard as one test sets it, put back afterwards (jsdom has none).
let restoreClipboard: (() => void) | null = null;
afterEach(() => {
  cleanup();
  restoreClipboard?.();
  restoreClipboard = null;
});

// The mock's active address and fixed 配对码 (mock/extension.ts).
const ORIGIN = 'http://10.250.0.222:8888';
const CODE = 'K7MQ2PXD';

function renderSection(options: Partial<MockOptions> = {}) {
  window.location.hash = '#/settings';
  const adapter = createMockAdapter({ seed: 'actions', fault: null, localExecutorInstallMs: 50, ...options });
  render(<App adapter={adapter} localExecutor={adapter.localExecutor} />);
  return { adapter, section: () => within(screen.getByRole('region', { name: LOCAL_EXECUTOR_COPY.title })) };
}

describe('设置页：baox 本地执行器的安装命令', () => {
  test('不预先选系统；选了 Mac 或 Windows 之后「生成安装命令」才能点', async () => {
    const { section } = renderSection();
    await screen.findByRole('region', { name: LOCAL_EXECUTOR_COPY.title });
    const mac = section().getByRole('radio', { name: LOCAL_EXECUTOR_COPY.systems.mac }) as HTMLInputElement;
    const windows = section().getByRole('radio', { name: LOCAL_EXECUTOR_COPY.systems.windows }) as HTMLInputElement;
    expect(mac.checked).toBe(false);
    expect(windows.checked).toBe(false);
    expect((section().getByRole('button', { name: LOCAL_EXECUTOR_COPY.generate }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(windows);
    expect((section().getByRole('button', { name: LOCAL_EXECUTOR_COPY.generate }) as HTMLButtonElement).disabled).toBe(false);
  });

  test('Mac：给出 curl … | sh 的命令和复制按钮', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true, writable: true });
    restoreClipboard = () => Reflect.deleteProperty(navigator, 'clipboard');
    const { section } = renderSection();
    await screen.findByRole('region', { name: LOCAL_EXECUTOR_COPY.title });
    fireEvent.click(section().getByRole('radio', { name: LOCAL_EXECUTOR_COPY.systems.mac }));
    fireEvent.click(section().getByRole('button', { name: LOCAL_EXECUTOR_COPY.generate }));
    const command = `curl -fsSL ${ORIGIN}/install/${CODE} | sh`;
    expect(await section().findByText(command)).toBeTruthy();
    expect(section().getByText(LOCAL_EXECUTOR_COPY.pasteHint.mac)).toBeTruthy();
    fireEvent.click(section().getByRole('button', { name: LOCAL_EXECUTOR_COPY.copy }));
    expect(await section().findByText(LOCAL_EXECUTOR_COPY.copied)).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith(command);
  });

  test('Windows：给出 powershell … irm … | iex 的命令和复制按钮', async () => {
    const { section } = renderSection();
    await screen.findByRole('region', { name: LOCAL_EXECUTOR_COPY.title });
    fireEvent.click(section().getByRole('radio', { name: LOCAL_EXECUTOR_COPY.systems.windows }));
    fireEvent.click(section().getByRole('button', { name: LOCAL_EXECUTOR_COPY.generate }));
    expect(await section().findByText(`powershell -ExecutionPolicy Bypass -c "irm ${ORIGIN}/install/${CODE} | iex"`)).toBeTruthy();
    expect(section().getByText(LOCAL_EXECUTOR_COPY.pasteHint.windows)).toBeTruthy();
    expect(section().getByRole('button', { name: LOCAL_EXECUTOR_COPY.copy })).toBeTruthy();
  });

  test('命令跑完、配对落地后，不用点任何东西，这一节自己变成已连接', async () => {
    const { section } = renderSection();
    await screen.findByRole('region', { name: LOCAL_EXECUTOR_COPY.title });
    fireEvent.click(section().getByRole('radio', { name: LOCAL_EXECUTOR_COPY.systems.mac }));
    fireEvent.click(section().getByRole('button', { name: LOCAL_EXECUTOR_COPY.generate }));
    await section().findByText(`curl -fsSL ${ORIGIN}/install/${CODE} | sh`);
    expect(section().queryByText(LOCAL_EXECUTOR_COPY.connected)).toBeNull();
    expect(await section().findByText(LOCAL_EXECUTOR_COPY.connected)).toBeTruthy();
    expect(section().queryByText(`curl -fsSL ${ORIGIN}/install/${CODE} | sh`)).toBeNull();
  });
});

describe('设置页：这台电脑上已有本地执行器在应答', () => {
  test('「连接这台电脑的执行器」代替「生成安装命令」，一键连上', async () => {
    const { section } = renderSection({ localExecutor: 'unpaired' });
    const connect = await screen.findByRole('button', { name: LOCAL_EXECUTOR_COPY.connectHere });
    expect(section().queryByRole('button', { name: LOCAL_EXECUTOR_COPY.generate })).toBeNull();
    expect(section().queryByRole('radio', { name: LOCAL_EXECUTOR_COPY.systems.mac })).toBeNull();
    fireEvent.click(connect);
    expect(await section().findByText(LOCAL_EXECUTOR_COPY.connected)).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('它配对的是另一个应用账号：先问，确认了才生成配对码交给它', async () => {
    const { adapter, section } = renderSection({ localExecutor: 'other' });
    fireEvent.click(await screen.findByRole('button', { name: LOCAL_EXECUTOR_COPY.connectHere }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(LOCAL_EXECUTOR_COPY.otherAccountBody)).toBeTruthy();
    expect((await adapter.getExtensionPairing()).status).toBe('none');
    fireEvent.click(within(dialog).getByRole('button', { name: LOCAL_EXECUTOR_COPY.otherAccountConfirm }));
    expect(await section().findByText(LOCAL_EXECUTOR_COPY.connected)).toBeTruthy();
    expect((await adapter.getExtensionPairing()).status).toBe('paired');
  });

  test('另一个账号的执行器，取消就什么都不变', async () => {
    const { adapter } = renderSection({ localExecutor: 'other' });
    fireEvent.click(await screen.findByRole('button', { name: LOCAL_EXECUTOR_COPY.connectHere }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect((await adapter.getExtensionPairing()).status).toBe('none');
  });
});

test('文案说报销系统、运行环境，不用破折号，不说重试', () => {
  const copy = JSON.stringify(LOCAL_EXECUTOR_COPY);
  expect(copy).not.toMatch(/ERP|Node|重试|[\u2013\u2014]/);
  expect(copy).not.toMatch(/Gatekeeper|SmartScreen|无法验证开发者|已保护你的电脑|解压|安装包/);
});
