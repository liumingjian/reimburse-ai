import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { LOCAL_EXECUTOR_DOWNLOAD_PATH } from '@baox/contract';
import { App } from '../App';
import { createMockAdapter } from '../mock/mock-adapter';
import { LOCAL_EXECUTOR_COPY } from './LocalExecutorSection';

// 设置页的 baox 本地执行器一节（ADR-0035）：按系统下载安装包、安装步骤，以及给它用的配对码。
// 安装包本身由服务端的 HTTP 缝检查（server/src/local-executor/package.test.ts）。

afterEach(cleanup);

function renderSection() {
  window.location.hash = '#/settings';
  render(<App adapter={createMockAdapter({ seed: 'actions', fault: null })} />);
  return () => screen.getByRole('region', { name: LOCAL_EXECUTOR_COPY.title });
}

describe('设置页：baox 本地执行器', () => {
  test('按 Windows、Apple 芯片 Mac、Intel 芯片 Mac 各给一个下载', async () => {
    const section = renderSection();
    await screen.findByRole('region', { name: LOCAL_EXECUTOR_COPY.title });
    const hrefs = within(section()).getAllByRole('link').map((link) => link.getAttribute('href'));
    expect(hrefs).toEqual([
      `${LOCAL_EXECUTOR_DOWNLOAD_PATH}?platform=win-x64`,
      `${LOCAL_EXECUTOR_DOWNLOAD_PATH}?platform=darwin-arm64`,
      `${LOCAL_EXECUTOR_DOWNLOAD_PATH}?platform=darwin-x64`,
    ]);
    expect(within(section()).getByRole('list', { name: LOCAL_EXECUTOR_COPY.stepsTitle }).children).toHaveLength(LOCAL_EXECUTOR_COPY.steps.length);
  });

  test('生成配对码后在这一节显示它', async () => {
    const section = renderSection();
    await screen.findByRole('region', { name: LOCAL_EXECUTOR_COPY.title });
    expect(within(section()).queryByText(LOCAL_EXECUTOR_COPY.codeHint)).toBeNull();
    fireEvent.click(within(section()).getByRole('button', { name: LOCAL_EXECUTOR_COPY.issue }));
    expect(await within(section()).findByText(LOCAL_EXECUTOR_COPY.codeHint)).toBeTruthy();
  });

  test('文案不提 ERP，不用破折号', () => {
    const copy = JSON.stringify(LOCAL_EXECUTOR_COPY);
    expect(copy).not.toMatch(/ERP|重试|[\u2013\u2014]/);
  });
});
