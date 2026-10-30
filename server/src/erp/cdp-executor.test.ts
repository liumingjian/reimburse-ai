import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import * as chromiumBrowser from '@baox/erp-executor/browser';
import type { ExecutorChannel, ExecutorEvent } from '@baox/erp-executor/protocol';
import type { CdpTarget } from '@baox/erp-executor/cdp';
import { erpEntryOf } from '@baox/erp-executor/probe';
import { createFakeErp } from '@baox/erp-executor/testing/fake-erp';
import { fillPlan, fakeErpOptions } from '@baox/erp-executor/testing/scenario';
import { stubServer } from '@baox/erp-executor/testing/stub-server';
import { cdpFillExecutor } from './cdp-executor';

async function browserFixture(initialUrls: string[], failCreate = false) {
  const fake = await createFakeErp(fakeErpOptions({ recording: 'new-form' }));
  const pages: CdpTarget[] = [];
  const created: string[] = [];
  const commands: string[] = [];
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/json/list') res.end(JSON.stringify(pages));
    else if (req.url === '/json/version') res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/browser` }));
    else { res.statusCode = 404; res.end('{}'); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const addPage = (url: string) => {
    const id = `page-${pages.length}`;
    pages.push({ id, type: 'page', url, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/${id}` });
    return id;
  };
  initialUrls.forEach(addPage);
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', (socket) => socket.on('message', async (data) => {
    const { id, method, params } = JSON.parse(String(data));
    commands.push(method);
    try {
      let result;
      if (method === 'Target.createTarget') {
        if (failCreate) throw new Error('target creation refused');
        created.push(params.url);
        result = { targetId: addPage(params.url) };
      } else result = await fake.session.send(method, params);
      socket.send(JSON.stringify({ id, result }));
    } catch (error) { socket.send(JSON.stringify({ id, error: { message: String(error) } })); }
  }));
  return {
    port, pages, created, commands,
    async close() {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>(resolve => sockets.close(() => resolve()));
      await new Promise<void>(resolve => server.close(() => resolve()));
      fake.session.close();
    },
  };
}

const plan = fillPlan('empty-browser');
async function run(browser: Awaited<ReturnType<typeof browserFixture>>, off = false) {
  const protocol = stubServer({ taskId: plan.taskId });
  const result = await cdpFillExecutor({ dataDir: '/unused', env: { BAOX_CHROMIUM_CDP_PORT: String(browser.port), ...(off ? { BAOX_ERP_CHROMIUM: 'off' } : {}) } })(plan, {
    emit: (async (event: ExecutorEvent) => {
      const ack = await (protocol.channel.emit as (event: ExecutorEvent) => Promise<unknown>)(event);
      if (event.type === 'step' && event.step === 'login' && event.status === 'done') throw new Error('test stops after login');
      return ack;
    }) as ExecutorChannel['emit'],
  }, { credentials: { account: 'test', password: 'test' }, trigger: 'start' });
  return { result, events: protocol.events, attempts: protocol.attempts };
}

describe('development CDP browser readiness', () => {
  it.each([{ urls: [] }, { urls: ['https://unrelated.example/form'] }, { urls: [`${plan.erpOrigin}.unrelated.example/form`] }])('opens ERP when a reachable browser has no ERP page ($urls)', async ({ urls }) => {
    const browser = await browserFixture(urls);
    try {
      const { events, attempts } = await run(browser);
      expect(browser.created).toEqual([erpEntryOf(plan.erpOrigin)]);
      expect(browser.pages.map(page => page.url)).toEqual([...urls, erpEntryOf(plan.erpOrigin)]);
      expect(events).toContainEqual({ type: 'step', step: 'login', status: 'done' });
      expect(attempts).toEqual([]);
      expect(browser.commands).not.toContain('Page.navigate');
      expect(browser.commands).not.toContain('Target.closeTarget');
    } finally { await browser.close(); }
  });

  it('waits for a newly launched browser initial page instead of opening a duplicate', async () => {
    const browser = await browserFixture(['about:blank']);
    const startup = vi.spyOn(chromiumBrowser, 'ensureChromium').mockResolvedValueOnce({ started: true, pid: null });
    const navigation = setTimeout(() => { browser.pages[0]!.url = erpEntryOf(plan.erpOrigin); }, 150);
    try {
      const { events } = await run(browser);
      expect(browser.created).toEqual([]);
      expect(events).toContainEqual({ type: 'step', step: 'login', status: 'done' });
    } finally { clearTimeout(navigation); startup.mockRestore(); await browser.close(); }
  });

  it('preserves an existing same-origin form without opening or reloading a page', async () => {
    const urls = [`${plan.erpOrigin}/K3Cloud/form?unsaved=1`];
    const browser = await browserFixture(urls);
    try {
      const { events } = await run(browser);
      expect(browser.created).toEqual([]);
      expect(browser.pages.map(page => page.url)).toEqual(urls);
      expect(events).toContainEqual({ type: 'step', step: 'login', status: 'done' });
      expect(browser.commands).not.toContain('Page.navigate');
      expect(browser.commands).not.toContain('Target.closeTarget');
    } finally { await browser.close(); }
  });

  it('reports browser readiness failure when creating a target fails', async () => {
    const browser = await browserFixture([], true);
    try {
      const { result, attempts } = await run(browser);
      expect(result).toMatchObject({ status: 'aborted', code: 'CHROMIUM_CDP_UNAVAILABLE' });
      expect(result.message).not.toContain('设置页');
      expect(attempts).toEqual([]);
    } finally { await browser.close(); }
  });

  it('does not open targets when automatic browser startup is disabled', async () => {
    const browser = await browserFixture([]);
    try {
      const { result, attempts } = await run(browser, true);
      expect(browser.created).toEqual([]);
      expect(result).toMatchObject({ status: 'aborted', code: 'erp_no_tab' });
      expect(result.message).not.toContain('设置页');
      expect(attempts).toEqual([]);
    } finally { await browser.close(); }
  });
});
