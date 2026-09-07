/**
 * 手动 QA（2026-09-07，`.claude/skills` 项目域安装）报回来的两件事，各钉一条用例。
 *
 * 两条都是**用户看得见的症状**，不是实现细节：
 *   1. 身份确认还在弹本地页面 —— 规格写的是会话内那张表；
 *   2. 一份一个字段都没有的读数被当成读数收下了，
 *      于是"识别出来的信息全是空的"能一路走到用户面前的确认表。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

process.env.BAOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-qa-'));

const { stepFor } = await import('../src/next.mjs');
const { takeInventory } = await import('../src/inventory.mjs');
const { createTask } = await import('../src/workspace.mjs');
const { ingestReadings } = await import('../src/vision.mjs');
const { SCHEMA_VERSION } = await import('../src/state.mjs');

const me = { displayName: '刘明建', account: 'luo.liu', tenant: '5f1f13f6dde29e' };
const unbound = {
  schemaVersion: SCHEMA_VERSION,
  nodeVersion: '22.14.0', nodeMajor: 22,
  cdpUp: true,
  probe: { status: 'matched', identity: me },
  binding: null,
};

test('第一次认身份走终端表格，不弹本地页面', () => {
  const shaped = stepFor('env_identity_unbound', unbound);
  assert.equal(shaped.step.kind, 'confirm_table',
    '规格那一格写的是「会话内列表格请用户认」');
  assert.ok(shaped.step.table && shaped.step.table.includes(me.displayName),
    '表里要有内核自己从 ERP 读到的那个人，用户对着它认');
  assert.equal(shaped.step.acceptsCorrection, false,
    '身份没有"改一个字"这种收场：是本人或不是本人');
  assert.equal(shaped.step.outsourceable, false, '要人表态的一步不能外包给子 Agent');
  assert.ok(!JSON.stringify(shaped.step).includes('confirm-identity'),
    '这一步不再让模型去跑那条会开页面的命令');
  assert.ok(!/页面|浏览器/.test(shaped.speak),
    `念给用户听的话里不该再提页面：${shaped.speak}`);
});

test('在终端上认下的那一个人，真的落进 identity.json', async () => {
  const { receiveIdentity } = await import('../src/confirm.mjs');
  const { readBinding } = await import('../src/binding.mjs');
  const shown = { meta: { account: me.account, tenant: me.tenant } };
  const probeAs = (identity) => async () => ({ status: 'matched', identity });

  // 用户看的是 A，回传的这一刻 ERP 上登录的却是 B —— 这次点头当场作废。
  const other = { displayName: '张三', account: 'zhang.san', tenant: me.tenant };
  assert.equal(await receiveIdentity(shown, { probe: probeAs(other) }), null);
  assert.equal(readBinding(), null, '对不上的时候一个字都不写');

  const r = await receiveIdentity(shown, { probe: probeAs(me) });
  assert.equal(r.verdict, 'identity_bound');
  assert.equal(readBinding().account, me.account, '认下来就是落盘，不再需要点任何页面');
  assert.equal(readBinding().tenant, me.tenant);
});

const repo = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const src = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-qa-src-'));
fs.copyFileSync(path.join(repo, 'resources', '交通', 'fengyun-1.png'), path.join(src, 'invoice.png'));
const inventory = await takeInventory(src);
const material = inventory.materials[0];
const task = createTask(src);

// QA 现场那一份读数：形状答对了（`mdls` 就答得出来），字段一个没有，全进 unreadable。
const emptyReading = (docType) => ({
  materialId: material.materialId,
  contentHash: material.contentHash,
  sighted: { shape: 'landscape' },
  docType,
  fields: {},
  unreadable: ['invoiceNumber', 'totalAmount', 'issueDate'],
});

test('一个字段都没读出来的读数不算读数', () => {
  const v = ingestReadings(src, inventory, task, { version: 1, readings: [emptyReading('ride_itinerary')] })[0];
  assert.equal(v.verdict, 'rejected',
    '空读数被收下，用户看到的就是一张什么都没有的确认表');
  assert.ok(v.reasons.some((r) => /没有|一个字段/.test(r)), `驳回理由要点破空读数：${v.reasons}`);
});

test('把整张图判成看不清，同样不算读数', () => {
  const v = ingestReadings(src, inventory, task, { version: 1, readings: [emptyReading('unreadable')] })[0];
  assert.equal(v.verdict, 'rejected',
    '一张内核解得开的正常图被整张判成看不清，多半是没真看见，而不是图不清楚');
});

test('连着交空读数，就不再让模型重试，转成摆给用户的待办', async () => {
  const { classifyInventory, classifyOpenItems } = await import('../src/classify.mjs');
  const { buildWorkOrder, MAX_EMPTY_READINGS } = await import('../src/vision.mjs');
  // 单独一个任务，免得和上面几条用例共用同一份驳回记录。
  const solo = createTask(src);
  for (let i = 0; i < MAX_EMPTY_READINGS; i += 1) {
    ingestReadings(src, inventory, solo, { version: 1, readings: [emptyReading('unreadable')] });
  }
  const classification = classifyInventory(src, inventory, solo);
  const items = classifyOpenItems(classification);
  const blind = items.find((x) => x.kind === 'vision_unavailable');
  assert.ok(blind, `到了上限要有一条 vision_unavailable：${items.map((x) => x.kind).join(',')}`);
  assert.ok(blind.blocking, '它拦路 —— 空着的读数不能当成读完了');
  assert.match(blind.note, /模型|PDF/, '要告诉用户两条出路：换个看得见图的模型，或者换 PDF 原件');
  assert.equal(buildWorkOrder(src, inventory, classification, solo).length, 0,
    '到了上限就不再派工单：再读一遍只是再空一次');
});
