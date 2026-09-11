import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  authorizeErpTaskSpacePage,
  authorizeErpWritePage,
  chromiumErpWriteTransport,
  egoErpWriteTransport,
  prepareErpWrite,
} from '../src/erp-write-context.mjs';

test('ERP 写入授权必须显式请求 ego task-space transport', async () => {
  let received;
  const result = await authorizeErpTaskSpacePage({
    authorize: async (options) => { received = options; return { ok: true, page: { transport: 'ego' } }; },
  });
  assert.deepEqual(received, { transport: egoErpWriteTransport() });
  assert.equal(result.page.transport, 'ego');
});

test('普通写入授权请求 Chromium transport，并在授权后附加同一页面', async () => {
  let received;
  let attached;
  const result = await authorizeErpWritePage({
    env: { BAOX_BROWSER: 'system' },
    authorize: async (options) => {
      received = options;
      return { ok: true, page: { transport: 'default', browserFamily: 'chromium' } };
    },
    attach: async (page, options) => {
      attached = { page, options };
      return { ...page, automation: 'cdp', session: { send() {} } };
    },
  });
  assert.deepEqual(received.transport, chromiumErpWriteTransport({ env: { BAOX_BROWSER: 'system' } }));
  assert.equal(attached.page.transport, 'default');
  assert.equal(attached.options.env.BAOX_BROWSER, 'system');
  assert.equal(result.page.automation, 'cdp');
});

test('导航失败时不得建立 upload_dispatched 标记', async () => {
  let marked = false;
  await assert.rejects(() => prepareErpWrite({
    page: { transport: 'ego' },
    navigate: async () => { throw new Error('navigate failed'); },
    read: async () => { throw new Error('read must not run'); },
    openAssistant: async () => { throw new Error('assistant must not run'); },
    mark: async () => { marked = true; return { erpWriteState: 'upload_dispatched' }; },
  }), /navigate failed/);
  assert.equal(marked, false);
});

test('只有空白新增单和发票助手准备完成后才建立 upload_dispatched 标记', async () => {
  const calls = [];
  const result = await prepareErpWrite({
    page: { transport: 'ego' },
    navigate: async () => calls.push('navigate'),
    read: async () => ({ formMode: { value: 'new' }, billNo: { value: null }, receiptsGrid: { rows: [] } }),
    openAssistant: async () => calls.push('assistant'),
    mark: async () => { calls.push('mark'); return { erpWriteState: 'upload_dispatched' }; },
  });
  assert.deepEqual(calls, ['navigate', 'assistant', 'mark']);
  assert.equal(result.markedTask.erpWriteState, 'upload_dispatched');
});
