import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { App } from '../App';
import { createMockAdapter } from '../mock/mock-adapter';
import { ERP_BROWSER_SETTINGS_COPY as COPY } from './ErpBrowserSettingsSection';

function adapter() {
  window.location.hash = '#/settings';
  return createMockAdapter({ seed: 'actions', fault: null, pairing: 'none' });
}
const panel = () => within(screen.getByRole('region', { name: COPY.title }));
const checked = (name: string) => (panel().getByRole('radio', { name }) as HTMLInputElement).checked;

test('settings default to headless; explicit save persists across settings visits without credentials or pairing', async () => {
  const mock = adapter();
  const saveCredentials = vi.spyOn(mock, 'saveErpCredentials');
  const trial = vi.spyOn(mock, 'testErpCredentials');
  vi.spyOn(mock, 'getErpCredentials').mockResolvedValue({ employeeProfile: { status: 'missing' }, available: false, status: 'none', erpAccount: null, savedAt: null, checkedAt: null, message: null });
  const app = render(<App adapter={mock} localExecutor={mock.localExecutor} />);
  await screen.findByRole('radio', { name: COPY.headless });
  expect(checked(COPY.headless)).toBe(true);
  fireEvent.click(panel().getByRole('radio', { name: COPY.headed }));
  expect(await mock.getErpBrowserSettings()).toEqual({ browserMode: 'headless' });
  fireEvent.click(panel().getByRole('button', { name: COPY.save }));
  await screen.findByText(COPY.saved);
  expect(await mock.getErpBrowserSettings()).toEqual({ browserMode: 'headed' });
  expect(saveCredentials).not.toHaveBeenCalled();
  expect(trial).not.toHaveBeenCalled();
  app.unmount();
  render(<App adapter={mock} localExecutor={mock.localExecutor} />);
  await screen.findByRole('radio', { name: COPY.headed });
  expect(checked(COPY.headed)).toBe(true);
  expect(panel().getByText(COPY.applies)).toBeTruthy();
});

test('failed save keeps the selected draft and allows retry', async () => {
  const mock = adapter();
  vi.spyOn(mock, 'saveErpBrowserSettings').mockResolvedValueOnce({ ok: false, error: { code: 'offline', message: '保存失败，请重试' }, settings: null });
  render(<App adapter={mock} localExecutor={mock.localExecutor} />);
  fireEvent.click(await screen.findByRole('radio', { name: COPY.headed }));
  fireEvent.click(panel().getByRole('button', { name: COPY.save }));
  await screen.findByText('保存失败，请重试');
  expect(checked(COPY.headed)).toBe(true);
  expect(await mock.getErpBrowserSettings()).toEqual({ browserMode: 'headless' });
  fireEvent.click(panel().getByRole('button', { name: COPY.save }));
  await screen.findByText(COPY.saved);
  expect(await mock.getErpBrowserSettings()).toEqual({ browserMode: 'headed' });
});

test('load failure offers retry and only then permits editing', async () => {
  const mock = adapter();
  vi.spyOn(mock, 'getErpBrowserSettings').mockRejectedValueOnce(new Error('暂时断网'));
  render(<App adapter={mock} localExecutor={mock.localExecutor} />);
  await screen.findByText('暂时断网');
  expect(panel().queryByRole('radio')).toBeNull();
  fireEvent.click(panel().getByRole('button', { name: COPY.retry }));
  await screen.findByRole('radio', { name: COPY.headless });
  expect(checked(COPY.headless)).toBe(true);
});

test('loading and saving prevent premature actions', async () => {
  const mock = adapter();
  let finishLoad!: (value: { browserMode: 'headless' }) => void;
  vi.spyOn(mock, 'getErpBrowserSettings').mockReturnValueOnce(new Promise((resolve) => { finishLoad = resolve; }));
  let finishSave!: (value: { ok: true; settings: { browserMode: 'headed' } }) => void;
  vi.spyOn(mock, 'saveErpBrowserSettings').mockReturnValueOnce(new Promise((resolve) => { finishSave = resolve; }));
  render(<App adapter={mock} localExecutor={mock.localExecutor} />);
  await screen.findByText(COPY.loading);
  expect(panel().queryByRole('radio')).toBeNull();
  finishLoad({ browserMode: 'headless' });
  fireEvent.click(await screen.findByRole('radio', { name: COPY.headed }));
  fireEvent.click(panel().getByRole('button', { name: COPY.save }));
  expect((panel().getByRole('button', { name: COPY.saving }) as HTMLButtonElement).disabled).toBe(true);
  expect(panel().getByRole('radio', { name: COPY.headless }).matches(':disabled')).toBe(true);
  finishSave({ ok: true, settings: { browserMode: 'headed' } });
  await waitFor(() => expect(panel().getByText(COPY.saved)).toBeTruthy());
});
