import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { LOCAL_EXECUTOR_PAIRING_ERRORS, type LocalExecutorPairAnswer, type LocalExecutorPairingState } from '@baox/contract';
import { App } from '../App';
import { SILENT_LOCAL_EXECUTOR_PORT, type LocalExecutorPort } from '../adapter/local-executor-port';
import { createMockAdapter, type MockOptions } from '../mock/mock-adapter';
import { LOCAL_EXECUTOR_COPY, LOCAL_EXECUTOR_POLL_MS } from './LocalExecutorSection';
import { REIMBURSE_METHOD_COPY } from './reimburse-method';

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

// A port the test drives by hand: what `probe` answers next, and what `pair` answers.
type FakePort = LocalExecutorPort & { probes: () => number; answer: (state: LocalExecutorPairingState | null) => void };
function fakePort(first: LocalExecutorPairingState | null, pair: LocalExecutorPort['pair'] = async () => null, delayMs = 0): FakePort {
  let next = first;
  let count = 0;
  return {
    probe: async () => {
      count += 1;
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return next;
    },
    pair,
    probes: () => count,
    answer: (state) => {
      next = state;
    },
  };
}

function renderWithPort(port: LocalExecutorPort, options: Partial<MockOptions> = {}) {
  window.location.hash = '#/settings';
  const adapter = createMockAdapter({ seed: 'actions', fault: null, localExecutorInstallMs: 50, ...options });
  render(<App adapter={adapter} localExecutor={port} />);
  return { adapter, section: () => within(screen.getByRole('region', { name: LOCAL_EXECUTOR_COPY.title })) };
}

const methodRadio = () => screen.getByRole('radio', { name: REIMBURSE_METHOD_COPY.options.local_executor }) as HTMLInputElement;
const insideTrouble = (element: HTMLElement) => element.closest('details') !== null;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const MAC_COMMAND = `curl -fsSL ${ORIGIN}/install/${CODE} | sh`;

async function generateMac(section: () => ReturnType<typeof within>) {
  await screen.findByRole('region', { name: LOCAL_EXECUTOR_COPY.title });
  fireEvent.click(section().getByRole('radio', { name: LOCAL_EXECUTOR_COPY.systems.mac }));
  fireEvent.click(section().getByRole('button', { name: LOCAL_EXECUTOR_COPY.generate }));
  await section().findByText(MAC_COMMAND);
}

describe('设置页：撤销本地执行器的配对', () => {
  test('已连接时可以撤销，要先确认；撤销后仍停在本地执行器，这台电脑的执行器还在就一键重连', async () => {
    const { adapter, section } = renderSection({ localExecutor: 'paired' });
    await screen.findByRole('region', { name: LOCAL_EXECUTOR_COPY.title });
    expect(await section().findByText(LOCAL_EXECUTOR_COPY.connected)).toBeTruthy();
    fireEvent.click(section().getByRole('button', { name: LOCAL_EXECUTOR_COPY.revoke }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(LOCAL_EXECUTOR_COPY.revokeBody)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: LOCAL_EXECUTOR_COPY.revokeConfirm }));
    expect(await section().findByRole('button', { name: LOCAL_EXECUTOR_COPY.connectHere })).toBeTruthy();
    expect(section().queryByText(LOCAL_EXECUTOR_COPY.connected)).toBeNull();
    expect((await adapter.getExtensionPairing()).status).toBe('none');
    expect(methodRadio().checked).toBe(true);
  });

  test('这台电脑没有执行器应答：撤销后给出「生成安装命令」', async () => {
    const { adapter, section } = renderWithPort(SILENT_LOCAL_EXECUTOR_PORT, { localExecutor: 'paired' });
    await screen.findByRole('region', { name: LOCAL_EXECUTOR_COPY.title });
    expect(await section().findByText(LOCAL_EXECUTOR_COPY.connected)).toBeTruthy();
    fireEvent.click(section().getByRole('button', { name: LOCAL_EXECUTOR_COPY.revoke }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: LOCAL_EXECUTOR_COPY.revokeConfirm }));
    await waitFor(() => expect(section().queryByText(LOCAL_EXECUTOR_COPY.connected)).toBeNull());
    expect(insideTrouble(section().getByRole('button', { name: LOCAL_EXECUTOR_COPY.generate }))).toBe(false);
    expect((await adapter.getExtensionPairing()).status).toBe('none');
    expect(methodRadio().checked).toBe(true);
  });

  test('取消撤销就什么都不变', async () => {
    const { adapter, section } = renderSection({ localExecutor: 'paired' });
    await screen.findByRole('region', { name: LOCAL_EXECUTOR_COPY.title });
    fireEvent.click(await section().findByRole('button', { name: LOCAL_EXECUTOR_COPY.revoke }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect((await adapter.getExtensionPairing()).status).toBe('paired');
    expect(section().getByText(LOCAL_EXECUTOR_COPY.connected)).toBeTruthy();
  });
});

describe('设置页：已连接时不会一点就断开', () => {
  test('「生成安装命令」收进「安装遇到问题？」，生成前先问；取消就还连着', async () => {
    const { adapter, section } = renderWithPort(SILENT_LOCAL_EXECUTOR_PORT, { localExecutor: 'paired' });
    await screen.findByRole('region', { name: LOCAL_EXECUTOR_COPY.title });
    expect(await section().findByText(LOCAL_EXECUTOR_COPY.connected)).toBeTruthy();
    const generate = section().getByRole('button', { name: LOCAL_EXECUTOR_COPY.generate });
    expect(insideTrouble(generate)).toBe(true);
    fireEvent.click(section().getByRole('radio', { name: LOCAL_EXECUTOR_COPY.systems.mac }));
    fireEvent.click(generate);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(LOCAL_EXECUTOR_COPY.reinstallBody)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    expect((await adapter.getExtensionPairing()).status).toBe('paired');
  });

  test('确认重新生成：给出新的安装命令', async () => {
    const { section } = renderWithPort(SILENT_LOCAL_EXECUTOR_PORT, { localExecutor: 'paired', localExecutorInstallMs: 60_000 });
    await screen.findByRole('region', { name: LOCAL_EXECUTOR_COPY.title });
    expect(await section().findByText(LOCAL_EXECUTOR_COPY.connected)).toBeTruthy();
    fireEvent.click(section().getByRole('radio', { name: LOCAL_EXECUTOR_COPY.systems.windows }));
    fireEvent.click(section().getByRole('button', { name: LOCAL_EXECUTOR_COPY.generate }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: LOCAL_EXECUTOR_COPY.reinstallConfirm }));
    expect(await section().findByText(`powershell -ExecutionPolicy Bypass -c "irm ${ORIGIN}/install/${CODE} | iex"`)).toBeTruthy();
  });
});

describe('设置页：安装命令的配对码过期、离开再回来', () => {
  test('配对码失效后不再显示旧命令，说清楚要重新生成，也不再读配对', async () => {
    const { adapter, section } = renderSection({ localExecutorInstallMs: 60_000 });
    await screen.findByRole('region', { name: LOCAL_EXECUTOR_COPY.title });
    const reads = vi.spyOn(adapter, 'getExtensionPairing');
    await generateMac(section);
    // The server forgets an expired code: the pairing reads as none from then on.
    await adapter.revokeExtensionPairing();
    expect(await section().findByText(LOCAL_EXECUTOR_COPY.expired)).toBeTruthy();
    expect(section().queryByText(MAC_COMMAND)).toBeNull();
    const after = reads.mock.calls.length;
    await pause(LOCAL_EXECUTOR_POLL_MS * 2);
    expect(reads.mock.calls.length).toBe(after);
  });

  test('离开设置页后不再读配对', async () => {
    const { adapter, section } = renderSection({ localExecutorInstallMs: 60_000 });
    await screen.findByRole('region', { name: LOCAL_EXECUTOR_COPY.title });
    const reads = vi.spyOn(adapter, 'getExtensionPairing');
    await generateMac(section);
    cleanup();
    const after = reads.mock.calls.length;
    await pause(LOCAL_EXECUTOR_POLL_MS * 2);
    expect(reads.mock.calls.length).toBe(after);
  });

  test('切到浏览器扩展再切回来：命令还在，装好后照样自己变成已连接', async () => {
    const { section } = renderSection({ localExecutorInstallMs: 2_000 });
    await screen.findByRole('region', { name: LOCAL_EXECUTOR_COPY.title });
    await generateMac(section);
    fireEvent.click(screen.getByRole('radio', { name: REIMBURSE_METHOD_COPY.options.extension }));
    await screen.findByRole('region', { name: '浏览器扩展' });
    fireEvent.click(screen.getByRole('radio', { name: REIMBURSE_METHOD_COPY.options.local_executor }));
    expect(await section().findByText(MAC_COMMAND)).toBeTruthy();
    expect(await section().findByText(LOCAL_EXECUTOR_COPY.connected)).toBeTruthy();
  });

  test('复制不成功：请员工手动复制，并读给读屏软件', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => Promise.reject(new Error('denied')) }, configurable: true, writable: true });
    const execCommand = document.execCommand;
    Object.defineProperty(document, 'execCommand', { value: () => false, configurable: true, writable: true });
    restoreClipboard = () => {
      Reflect.deleteProperty(navigator, 'clipboard');
      Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true, writable: true });
    };
    const { section } = renderSection({ localExecutorInstallMs: 60_000 });
    await screen.findByRole('region', { name: LOCAL_EXECUTOR_COPY.title });
    await generateMac(section);
    fireEvent.click(section().getByRole('button', { name: LOCAL_EXECUTOR_COPY.copy }));
    const caption = await section().findByText(LOCAL_EXECUTOR_COPY.copyByHand);
    expect(caption.closest('[role="status"]')).not.toBeNull();
  });
});

describe('设置页：连接这台电脑的执行器没成', () => {
  test('执行器拒绝时说它的中文原因；说不清的错误换成一句固定的话', async () => {
    let answer: LocalExecutorPairAnswer = { ok: false, code: 'local_executor_busy', message: LOCAL_EXECUTOR_PAIRING_ERRORS.busy };
    const { section } = renderWithPort(fakePort({ paired: false }, async () => answer), { localExecutor: 'unpaired' });
    await screen.findByRole('region', { name: LOCAL_EXECUTOR_COPY.title });
    fireEvent.click(await section().findByRole('button', { name: LOCAL_EXECUTOR_COPY.connectHere }));
    expect(await section().findByText(LOCAL_EXECUTOR_PAIRING_ERRORS.busy)).toBeTruthy();
    answer = { ok: false, code: 'local_executor_error', message: 'EACCES: permission denied, open pairing.json' };
    fireEvent.click(section().getByRole('button', { name: LOCAL_EXECUTOR_COPY.connectHere }));
    expect(await section().findByText(LOCAL_EXECUTOR_COPY.pairFailed)).toBeTruthy();
    expect(section().queryByText(/EACCES/)).toBeNull();
  });

  test('执行器交接时没了应答：回到安装命令，并说明它没有应答', async () => {
    const { section } = renderWithPort(fakePort({ paired: false }, async () => null), { localExecutor: 'unpaired' });
    await screen.findByRole('region', { name: LOCAL_EXECUTOR_COPY.title });
    fireEvent.click(await section().findByRole('button', { name: LOCAL_EXECUTOR_COPY.connectHere }));
    expect(await section().findByText(LOCAL_EXECUTOR_COPY.silent)).toBeTruthy();
    expect(section().getByRole('button', { name: LOCAL_EXECUTOR_COPY.generate })).toBeTruthy();
  });
});

// Chrome and Edge may ask the employee before a page reaches this PC (local network access); real browsers are a
// release check (#430). Here: a late answer is kept, and coming back to the window asks again.
describe('设置页：浏览器迟一点才让页面连到这台电脑的执行器', () => {
  test('第一次询问答得慢：先给安装命令，答案到了照样换成一键连接', async () => {
    const { section } = renderWithPort(fakePort({ paired: false }, undefined, 2_500), { localExecutor: 'unpaired' });
    await screen.findByRole('region', { name: LOCAL_EXECUTOR_COPY.title });
    expect(await section().findByRole('button', { name: LOCAL_EXECUTOR_COPY.generate })).toBeTruthy();
    expect(await section().findByRole('button', { name: LOCAL_EXECUTOR_COPY.connectHere })).toBeTruthy();
  });

  test('第一次没有应答，回到这个窗口时再问一次', async () => {
    const port = fakePort(null);
    const { section } = renderWithPort(port, { localExecutor: 'unpaired' });
    await screen.findByRole('region', { name: LOCAL_EXECUTOR_COPY.title });
    await section().findByRole('button', { name: LOCAL_EXECUTOR_COPY.generate });
    await waitFor(() => expect(port.probes()).toBe(1));
    port.answer({ paired: false });
    fireEvent.focus(window);
    expect(await section().findByRole('button', { name: LOCAL_EXECUTOR_COPY.connectHere })).toBeTruthy();
  });

  test('切回这个标签页时也再问一次', async () => {
    const port = fakePort(null);
    const { section } = renderWithPort(port, { localExecutor: 'unpaired' });
    await screen.findByRole('region', { name: LOCAL_EXECUTOR_COPY.title });
    await section().findByRole('button', { name: LOCAL_EXECUTOR_COPY.generate });
    await waitFor(() => expect(port.probes()).toBe(1));
    port.answer({ paired: false });
    fireEvent(document, new Event('visibilitychange'));
    expect(await section().findByRole('button', { name: LOCAL_EXECUTOR_COPY.connectHere })).toBeTruthy();
  });
});

describe('设置页：账号连着另一台电脑的执行器', () => {
  test('这台电脑的执行器应答但没有配这个账号：照样给一键连接，先说明那一台会断开', async () => {
    window.location.hash = '#/settings';
    const adapter = createMockAdapter({ seed: 'actions', fault: null, localExecutor: 'paired' });
    // The account's pairing lives on another PC; the executor on this one answers unpaired.
    const port: LocalExecutorPort = { probe: async () => ({ paired: false }), pair: (code) => adapter.localExecutor.pair(code) };
    render(<App adapter={adapter} localExecutor={port} />);
    await screen.findByRole('region', { name: LOCAL_EXECUTOR_COPY.title });
    const section = () => within(screen.getByRole('region', { name: LOCAL_EXECUTOR_COPY.title }));
    expect(await section().findByText(LOCAL_EXECUTOR_COPY.connected)).toBeTruthy();
    fireEvent.click(await section().findByRole('button', { name: LOCAL_EXECUTOR_COPY.connectHere }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(LOCAL_EXECUTOR_COPY.otherPcBody)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: LOCAL_EXECUTOR_COPY.otherPcConfirm }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((await adapter.getExtensionPairing()).status).toBe('paired');
    expect(await section().findByText(LOCAL_EXECUTOR_COPY.connected)).toBeTruthy();
  });
});

test('文案说报销系统、运行环境，不用破折号，不说重试', () => {
  const copy = JSON.stringify(LOCAL_EXECUTOR_COPY);
  expect(copy).not.toMatch(/ERP|Node|重试|[\u2013\u2014]/);
  expect(copy).not.toMatch(/Gatekeeper|SmartScreen|无法验证开发者|已保护你的电脑|解压|安装包/);
});
