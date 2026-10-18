// #255 in a real Chromium: the extension opens its own ERP tab, attaches `chrome.debugger` to it alone, brings it to
// the front, and the executor's login probe and 报销信息核对 (master-data check) pass over it. The run then stops at
// fetching the invoices, before any attempt: the stand-in app serves no originals. #259 adds the full run and the
// mid-run detach to this same harness.
import { createHash } from 'node:crypto';
import type { CdpSession } from '@baox/erp-executor/cdp';
import { putFilesInPage } from '@baox/erp-executor/invoice-files';
import type { ExecutorEvent } from '@baox/erp-executor/protocol';
import { expect } from '@playwright/test';
import { fillPlan, test } from './harness';

const stepsDone = (events: ExecutorEvent[]) => events.flatMap((e) => (e.type === 'step' && e.status === 'done' ? [e.step] : []));

test('the login probe and the master-data check pass in a tab of the job\'s own, with the debugger on it alone', async ({ erp, baox, extension }) => {
  // The employee's own ERP tab, open before they press 去报销.
  const own = await extension.context.newPage();
  await own.goto(erp.entry);
  const tabsBefore = await extension.worker.evaluate(async () => (await chrome.tabs.query({})).map((tab) => tab.id));

  // Look at the browser while the job waits for its answer to 报销信息核对 done.
  const seen: { during?: { attached: Array<{ tabId?: number; url: string }>; active: Array<number | undefined>; visibility: string } } = {};
  baox.answerWith(async (event) => {
    if (event.type === 'step' && event.step === 'catalog' && event.status === 'done') {
      const { attached, active } = await extension.worker.evaluate(async () => {
        // `TargetInfo.attached` counts Playwright's own connection too, so ask Chrome the way only this extension's
        // debugger can be told apart: attaching again where it is already attached is refused.
        const attached: Array<{ tabId?: number; url: string }> = [];
        for (const tab of await chrome.tabs.query({})) {
          try {
            await chrome.debugger.attach({ tabId: tab.id! }, '1.3');
            await chrome.debugger.detach({ tabId: tab.id! });
          } catch (error) {
            if (/already attached/i.test((error as Error).message)) attached.push({ tabId: tab.id!, url: tab.url ?? '' });
          }
        }
        return { attached, active: (await chrome.tabs.query({ active: true, lastFocusedWindow: true })).map((tab) => tab.id) };
      });
      const jobPage = extension.context.pages().find((page) => page !== own && page.url().startsWith(erp.entry));
      seen.during = { attached, active, visibility: String(await jobPage?.evaluate(() => document.visibilityState)) };
    }
    return baox.defaultReply(event);
  });

  const result = await baox.fill(fillPlan(erp.erpOrigin));

  expect(stepsDone(baox.events)).toEqual(['chromium', 'login', 'catalog']);
  expect(baox.events.some((e) => e.type === 'attempt_started')).toBe(false);
  expect(result).toMatchObject({ type: 'result', status: 'aborted', code: 'INVOICE_BLOB_UNAVAILABLE' });

  expect(seen.during).toBeDefined();
  const { attached, active, visibility } = seen.during!;
  expect(attached).toHaveLength(1);
  const jobTab = attached[0]!.tabId;
  expect(tabsBefore).not.toContain(jobTab);
  expect(attached[0]!.url.startsWith(erp.entry)).toBe(true);
  expect(active).toEqual([jobTab]);
  expect(visibility).toBe('visible');

  // The debugger is let go at the end; the tab stays for the employee.
  const released = await extension.worker.evaluate(async (tabId) => {
    await chrome.debugger.attach({ tabId }, '1.3');
    await chrome.debugger.detach({ tabId });
    return (await chrome.tabs.get(tabId)).url;
  }, jobTab!);
  expect(released?.startsWith(erp.entry)).toBe(true);
});

test.describe('logged out of the ERP', () => {
  test.use({ erpLoggedIn: false });

  test('stops on the login page, in the tab it opened, and starts nothing', async ({ erp, baox, extension }) => {
    const result = await baox.fill(fillPlan(erp.erpOrigin));

    expect(result).toMatchObject({ status: 'aborted', code: 'erp_login' });
    expect(baox.events.some((e) => e.type === 'attempt_started')).toBe(false);
    const erpTabs = await extension.worker.evaluate(async (entry) => (await chrome.tabs.query({})).filter((tab) => tab.url?.startsWith(entry)).length, erp.entry);
    expect(erpTabs).toBe(1);
  });
});

// A measurement, not a behaviour: `erp-tab.ts` keeps focus emulation best-effort because nobody had seen whether
// `chrome.debugger` accepts it on a real foreground tab. This is Chromium's answer; the employee's Chrome is still
// unmeasured.
test('chrome.debugger accepts Emulation.setFocusEmulationEnabled on a foreground tab', async ({ erp, extension }) => {
  const answer = await extension.worker.evaluate(async (url) => {
    const tab = await chrome.tabs.create({ url, active: true });
    const target = { tabId: tab.id! };
    await chrome.debugger.attach(target, '1.3');
    try {
      await chrome.debugger.sendCommand(target, 'Emulation.setFocusEmulationEnabled', { enabled: true });
      return 'accepted';
    } catch (error) {
      return String((error as Error).message);
    } finally {
      await chrome.debugger.detach(target);
    }
  }, erp.entry);

  expect(answer).toBe('accepted');
});

// #256's mechanism in a real Chromium: `putFilesInPage`, sent over `chrome.debugger`, builds the files in the assistant
// page and assigns them to its hidden `multiple` input, and the page's own `change` handler reads back exactly the bytes
// handed in. Whether the LIVE assistant then recognises them is #250's question 2, which this cannot answer: the
// recorded page carries no behaviour of its own.
test('files built in the page over chrome.debugger reach the hidden file input\'s change handler intact', async ({ erp, extension }) => {
  const page = await extension.context.newPage();
  await page.goto(`${erp.assistantOrigin}/m4-web/fpzs/kdInvoices`);
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
    const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
    (window as unknown as { seen: Promise<unknown> }).seen = new Promise((resolve) => {
      input.addEventListener('change', async () => {
        resolve(await Promise.all([...(input.files ?? [])].map(async (file) => ({ name: file.name, type: file.type, sha256: hex(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())) }))));
      }, { once: true });
    });
  });
  const tabId = await extension.worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url: `${url}/*` });
    await chrome.debugger.attach({ tabId: tab!.id! }, '1.3');
    return tab!.id!;
  }, erp.assistantOrigin);
  const session: CdpSession = {
    send: (method, params = {}) => extension.worker.evaluate(({ tabId, method, params }) => chrome.debugger.sendCommand({ tabId }, method, params), { tabId, method, params }),
    close: () => undefined,
  };
  const files = [
    { name: '01-铁路电子客票.pdf', mime: 'application/pdf', bytes: new TextEncoder().encode('%PDF-1.4\n% rail\n%%EOF\n') },
    { name: '02-网约车发票.pdf', mime: 'application/pdf', bytes: new Uint8Array(70_000).map((_, i) => (i * 7) % 256) },
  ];

  await putFilesInPage(session, files);

  const seen = await page.evaluate(() => (window as unknown as { seen: Promise<unknown> }).seen);
  expect(seen).toEqual(files.map((file) => ({ name: file.name, type: file.mime, sha256: createHash('sha256').update(file.bytes).digest('hex') })));
});
