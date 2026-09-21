// The rehearsal, one button per step. Nothing runs automatically: the maintainer is at the keyboard for every
// step, and a step that fails leaves the run where it is rather than trying the next thing.
//
// The two questions of #250 are asked, in order, and the answer to each is whatever the page said — recorded
// verbatim, including "nothing happened". This file contains no expectation about either answer.

import { attach, clickPoint, createProbe, detach, evalIn, getTargets, sleep, waitFor, BrakeError } from './cdp.js';
import { selfTest } from './brake.js';
import * as page from './page.js';

const ERP_URL = 'http://erp.antute.com.cn/k3cloud/html5/index.aspx';

// 9.6 s, the settle the server-side executor uses before 电脑端选取 (pace.settleMs * 8). A click that lands before
// the assistant's own router has taken over performs a full page load of a route that loads but never mounts.
const PICKER_SETTLE_MS = 9_600;

const $ = (id) => document.getElementById(id);
const logLines = [];
const observations = {
  startedAt: new Date().toISOString(),
  userAgent: navigator.userAgent,
  q1: { asked: false, routes: [] },
  q2: { asked: false },
  readback: { asked: false },
};

let tabId = null;
let probe = null;
let assistant = null; // the DebuggerSession that addresses the piaozone child, once a route has produced one

// ---- logging ----

function render() {
  $('log').textContent = logLines.join('\n');
  $('log').scrollTop = $('log').scrollHeight;
  $('summary').textContent = summarise();
}

function log(entry) {
  const data = entry.data === undefined ? '' : ` ${JSON.stringify(entry.data)}`;
  logLines.push(`[${entry.at.slice(11, 19)}] ${entry.level.padEnd(5)} ${entry.message}${data}`);
  render();
}

const note = (message, data) => log({ at: new Date().toISOString(), level: 'step', message, data });
const fail = (message, data) => log({ at: new Date().toISOString(), level: 'FAIL', message, data });

/** Wrap a step so a failure is recorded and the run simply stops there. */
const step = (id, fn) => {
  $(id).addEventListener('click', async () => {
    $(id).disabled = true;
    try {
      await fn();
    } catch (error) {
      if (error instanceof BrakeError) fail(`刹车拦下了这一步：${error.message}`);
      else fail(String(error?.message ?? error));
    } finally {
      $(id).disabled = false;
    }
  });
};

// ---- the brake's own self-test, before anything else ----

const brakeResults = selfTest();
$('brake-table').innerHTML = brakeResults
  .map((r) => `<tr><td class="verdict ${r.pass ? 'ok' : 'bad'}">${r.pass ? '通过' : '不通过'}</td>`
    + `<td>${r.name}</td><td class="detail">${r.detail || '—'}</td></tr>`)
  .join('');
observations.brake = { allPassed: brakeResults.every((r) => r.pass), cases: brakeResults };
note(`防误点自检：${brakeResults.filter((r) => r.pass).length}/${brakeResults.length} 通过`);

// ---- steps ----

step('s1', async () => {
  const tab = await chrome.tabs.create({ url: ERP_URL, active: true });
  tabId = tab.id;
  note(`已打开报销系统页签 tabId=${tabId}。请在那个页签里登录，登录完回到本页继续。`);
});

step('s2', async () => {
  if (tabId === null) throw new Error('还没有报销系统页签，先点第 ① 步。');
  probe = createProbe({ onLog: log });
  await attach({ tabId });
  note('chrome.debugger.attach({tabId}) 成功。');
  // Auto-attach must be switched on BEFORE the assistant opens, or its birth event is missed. Whether the event
  // ever arrives, and whether it carries an addressable sessionId, is question (1)'s route B.
  const auto = await probe.send({ tabId }, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
    .then(() => ({ ok: true }), (error) => ({ ok: false, error: String(error.message) }));
  observations.autoAttach = auto;
  note(`Target.setAutoAttach {flatten:true}：${auto.ok ? '接受' : `拒绝 — ${auto.error}`}`);
  const snapshot = await evalIn(probe, { tabId }, page.FRAME_SNAPSHOT);
  observations.erpPage = snapshot;
  note('报销系统页面快照', snapshot);
});

step('s3', async () => {
  requireTab();
  if (await evalIn(probe, { tabId }, page.hasText('费用报销单-新增'))) {
    note('页面上已经有「费用报销单-新增」，这一步跳过。');
    return;
  }
  if (await evalIn(probe, { tabId }, page.hasText('我的费用报销'))) {
    await clickText('我的费用报销');
    await clickText('新增');
  } else {
    await clickWhere(page.cssPoint('.kd_SystemMenu'), 'ERP 主菜单');
    await clickText('员工服务');
    await clickText('我的费用报销');
    await clickText('新增');
  }
  const opened = await waitFor(() => evalIn(probe, { tabId }, page.hasText('费用报销单-新增')), Boolean, { timeoutMs: 45_000 });
  if (!opened) throw new Error('点过之后没有出现「费用报销单-新增」，新的费用报销单没有打开。');
  note('费用报销单-新增 已打开。');
});

step('s4', async () => {
  requireTab();
  await clickText('收票信息');
  await sleep(2_500);
  await clickWhere(page.cssPoint(page.SPLIT_ARROW), '选择发票下拉按钮');
  await sleep(1_200);
  let target = await evalIn(probe, { tabId }, page.importModePoint());
  if (!target?.ok) {
    note('下拉菜单没打开，改用 Kendo 自己的 toggle。');
    await evalIn(probe, { tabId }, page.TOGGLE_SPLIT_MENU);
    await sleep(600);
  }
  // Only a point that resolves to tbNotFillEntry is ever clicked: the two neighbours make ERP write the 费用明细
  // rows itself, over the bill this run is about to touch, and there is no second chance to choose.
  target = await waitFor(() => evalIn(probe, { tabId }, page.importModePoint()),
    (t) => t?.ok === true && String(t.hitId ?? '').endsWith(page.NOT_FILL_ENTRY), { timeoutMs: 30_000 });
  if (!(target?.ok && String(target.hitId ?? '').endsWith(page.NOT_FILL_ENTRY))) {
    throw new Error(`「不生成费用明细」没有确认落点，没有点它：${JSON.stringify(target)}`);
  }
  await clickPoint(probe, { tabId }, target, '不生成费用明细');
  observations.importMode = { selectedId: target.wantedId, menuItemIds: target.items };
  note('已点「不生成费用明细」，助手窗口应当弹出。', observations.importMode);
});

step('s5', async () => {
  requireTab();
  observations.q1.asked = true;
  // All three routes are tried even after one succeeds. #255/#256 need to know which of them work, not just that
  // one does: the route that works decides how the extension's CdpSession adapter is written.
  for (const run of [routeB, routeC, routeA]) {
    const result = await run().catch((error) => ({ route: run.name.slice(-1), ok: false, detail: String(error?.message ?? error) }));
    observations.q1.routes.push(result);
    note(`路径 ${result.route}：${result.ok ? '成功' : '失败'}`, result);
    if (result.ok && !assistant) {
      assistant = result.target;
      observations.q1.usedRoute = result.route;
    }
  }
  observations.q1.reached = Boolean(assistant);
  observations.q1.childTargets = probe.children().map((c) => ({ type: c.info.type, url: c.info.url, targetId: c.info.targetId }));
  observations.q1.targetEventSourceKeys = [...new Set(probe.targetEvents().flatMap((e) => e.sourceKeys))];
  note(assistant ? `问题①：触达成功，使用路径 ${observations.q1.usedRoute}。` : '问题①：三条路径都没有触达 piaozone iframe。');
});

step('s6', async () => {
  requireAssistant();
  const ready = await waitFor(() => evalIn(probe, assistant, page.ENTRY_READY), Boolean, { timeoutMs: 30_000 });
  if (!ready) throw new Error('发票助手的入口页没有就绪（四个入口没有全部出现，或 电脑端选取 还没有 href）。');
  note(`入口页就绪，静置 ${PICKER_SETTLE_MS / 1000} 秒再点 电脑端选取。`);
  await sleep(PICKER_SETTLE_MS);
  await dismissNotice();
  const point = await waitFor(() => evalIn(probe, assistant, page.COMPUTER_PICKER_POINT),
    (p) => p?.ok === true && p.onTarget === true, { timeoutMs: 15_000 });
  if (!(point?.ok && point.onTarget)) throw new Error(`找不到可点击的「电脑端选取」入口：${JSON.stringify(point)}`);
  await clickPoint(probe, assistant, point, '电脑端选取');
  const onUploadView = await waitFor(() => evalIn(probe, assistant, page.hasText('上传发票影像')), Boolean, { timeoutMs: 30_000 });
  if (!onUploadView) throw new Error('电脑端选取页没有打开：找不到「上传发票影像」。');
  await dismissNotice();
  const input = await evalIn(probe, assistant, page.FILE_INPUT_REPORT);
  observations.fileInput = input;
  note('上传页已打开，文件控件现状：', input);
  const before = await evalIn(probe, assistant, page.RECOGNISED);
  observations.beforeUpload = { total: before.total, panes: before.panes };
  if (before.total > 0) note(`注意：助手里已经有 ${before.total} 行识别结果，它们不是这次上传的。`, before.panes);
});

step('s7', async () => {
  requireAssistant();
  const picked = [...$('files').files];
  if (!picked.length) throw new Error('先选至少一个发票文件。');
  observations.q2.asked = true;
  observations.q2.files = picked.map((f) => ({ name: f.name, size: f.size, type: f.type }));
  note(`准备注入 ${picked.length} 个文件。`, observations.q2.files);

  for (const file of picked) {
    const base64 = await toBase64(file);
    const staged = await evalIn(probe, assistant, page.stageFile(file.name, file.type || 'application/pdf', base64));
    note(`已把 ${file.name} 的字节送进页面。`, staged);
  }

  const assigned = await evalIn(probe, assistant, page.ASSIGN_DATATRANSFER);
  observations.q2.assignment = assigned;
  note('DataTransfer 赋值结果：', assigned);

  // From here the spike only reads. The brake refuses every input event and every scripted click, so the run
  // cannot reach the import control even by accident.
  probe.sealReadOnly();
  observations.q2.sealedAt = new Date().toISOString();
});

step('s8', async () => {
  requireAssistant();
  observations.readback.asked = true;
  const want = (observations.q2.files?.length ?? 0) + (observations.beforeUpload?.total ?? 0);
  const state = await waitFor(() => evalIn(probe, assistant, page.RECOGNISED),
    (s) => s && !s.processing && s.total >= want && want > 0, { timeoutMs: 120_000, intervalMs: 2_000 });
  const notices = await evalIn(probe, assistant, page.ASSISTANT_NOTICES);
  observations.readback.state = state;
  observations.readback.notices = notices;
  observations.readback.recognisedThisRun = (state?.total ?? 0) - (observations.beforeUpload?.total ?? 0);
  note(`回读完成：助手共 ${state?.total ?? '?'} 行，本次新增 ${observations.readback.recognisedThisRun} 行。`, state);
  if (notices?.length) note('助手弹出的提示：', notices);
});

step('s9', async () => {
  if (tabId !== null) await detach({ tabId }).catch(() => {});
  for (const route of observations.q1.routes.filter((r) => r.ok && r.target?.targetId)) {
    await detach({ targetId: route.target.targetId }).catch(() => {});
  }
  observations.finishedAt = new Date().toISOString();
  note('调试器已卸载。排练结束，没有点「发票导入单据」，没有导入任何发票。');
});

// ---- question (1): the three candidate routes ----

/** Flat auto-attach: the manoeuvre the server-side executor uses, addressed the chrome.debugger way. */
async function routeB() {
  const child = probe.children().find((c) => String(c.info.url ?? '').includes('piaozone'));
  const sourceKeys = [...new Set(probe.targetEvents().flatMap((e) => e.sourceKeys))];
  if (!child) {
    return { route: 'B', ok: false, name: 'Target.setAutoAttach + {tabId, sessionId}', sourceKeys,
      detail: '没有收到 piaozone 的 Target.attachedToTarget 事件',
      seen: probe.children().map((c) => ({ type: c.info.type, url: c.info.url })) };
  }
  const target = { tabId, sessionId: child.sessionId };
  const href = await evalIn(probe, target, 'location.href');
  return { route: 'B', ok: true, name: 'Target.setAutoAttach + {tabId, sessionId}', target, href,
    childType: child.info.type, sourceKeys, sessionIdOnEvent: probe.targetEvents().some((e) => e.sessionId) };
}

/** Explicit attach over the protocol, then the same sessionId addressing. */
async function routeC() {
  const list = await probe.send({ tabId }, 'Target.getTargets');
  const infos = list?.targetInfos ?? [];
  const wanted = infos.find((t) => String(t.url ?? '').includes('piaozone'));
  if (!wanted) {
    return { route: 'C', ok: false, name: 'Target.getTargets + Target.attachToTarget',
      detail: 'Target.getTargets 里没有 piaozone 目标', infos: infos.map((t) => ({ type: t.type, url: t.url })) };
  }
  const { sessionId } = await probe.send({ tabId }, 'Target.attachToTarget', { targetId: wanted.targetId, flatten: true });
  const target = { tabId, sessionId };
  const href = await evalIn(probe, target, 'location.href');
  return { route: 'C', ok: true, name: 'Target.getTargets + Target.attachToTarget', target, href, childType: wanted.type };
}

/** A second, independent chrome.debugger attachment straight onto the iframe target. */
async function routeA() {
  const all = await getTargets();
  const wanted = all.find((t) => String(t.url ?? '').includes('piaozone'));
  if (!wanted) {
    return { route: 'A', ok: false, name: 'chrome.debugger.getTargets + attach({targetId})',
      detail: 'chrome.debugger.getTargets() 里没有 piaozone 目标',
      targets: all.map((t) => ({ type: t.type, url: t.url })) };
  }
  await attach({ targetId: wanted.id });
  const target = { targetId: wanted.id };
  const href = await evalIn(probe, target, 'location.href');
  return { route: 'A', ok: true, name: 'chrome.debugger.getTargets + attach({targetId})', target, href, childType: wanted.type };
}

// ---- helpers ----

function requireTab() {
  if (tabId === null || !probe) throw new Error('还没有挂上调试器，先点第 ② 步。');
}

function requireAssistant() {
  requireTab();
  if (!assistant) throw new Error('还没有触达发票助手的 iframe，先把第 ⑤ 步跑通。');
}

async function clickWhere(expression, label) {
  const point = await waitFor(() => evalIn(probe, { tabId }, expression),
    (p) => p?.ok === true && p.onTarget === true, { timeoutMs: 15_000 });
  if (!(point?.ok && point.onTarget)) throw new Error(`${label}点不到：${JSON.stringify(point)}`);
  return clickPoint(probe, { tabId }, point, label);
}

const clickText = (text) => clickWhere(page.textPoint(text), `「${text}」`);

/** The 温馨提示 modal covers the assistant's whole viewport and is answered only by its 知道了 button. */
async function dismissNotice() {
  const point = await evalIn(probe, assistant, page.NOTICE_POINT).catch(() => null);
  if (!(point?.ok && point.onTarget)) return false;
  await clickPoint(probe, assistant, point, '知道了');
  note('关掉了助手的「温馨提示」。');
  await sleep(1_200);
  return true;
}

const toBase64 = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(new Error(`读不出 ${file.name}`));
  reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
  reader.readAsDataURL(file);
});

// ---- what gets pasted into the findings doc ----

function summarise() {
  const q1 = observations.q1;
  const q2 = observations.q2;
  const readback = observations.readback;
  const verdict = (asked, value) => (asked ? value : '未运行');

  return [
    `运行时间：${observations.startedAt}${observations.finishedAt ? ` — ${observations.finishedAt}` : '（未结束）'}`,
    `浏览器：${observations.userAgent}`,
    `防误点自检：${observations.brake.allPassed ? '全部通过' : '有不通过项，见下方日志'}`,
    '',
    `问题①（chrome.debugger 能否触达 piaozone iframe）：${verdict(q1.asked, q1.reached ? `能，经路径 ${q1.usedRoute}` : '三条路径都不能')}`,
    ...q1.routes.map((r) => `  - 路径 ${r.route}（${r.name}）：${r.ok ? `成功，location.href = ${r.href}` : `失败 — ${r.detail ?? '见日志'}`}`),
    q1.asked ? `  - 自动挂接看到的子目标：${JSON.stringify(q1.childTargets)}` : '',
    q1.asked ? `  - Target.* 事件 source 上的字段：${JSON.stringify(q1.targetEventSourceKeys)}` : '',
    '',
    `问题②（Runtime.evaluate 里的 DataTransfer 能否触发识别）：${verdict(q2.asked, '见下面两行的实测值，不要在这里填结论')}`,
    q2.asked ? `  - 注入的文件：${JSON.stringify(q2.files)}` : '',
    q2.asked ? `  - 赋值结果：${JSON.stringify(q2.assignment)}` : '',
    readback.asked ? `  - 回读：助手共 ${readback.state?.total} 行，本次新增 ${readback.recognisedThisRun} 行，当前分页 ${readback.state?.activePane}` : '  - 回读：未运行',
    readback.asked ? `  - 分页：${JSON.stringify(readback.state?.panes)}` : '',
    readback.asked ? `  - 行：${JSON.stringify(readback.state?.rows)}` : '',
    readback.asked ? `  - 助手提示：${JSON.stringify(readback.notices)}` : '',
    '',
    `上传前助手里已有的行数：${observations.beforeUpload?.total ?? '未读'}`,
    `文件控件现状：${JSON.stringify(observations.fileInput ?? null)}`,
    '',
    '本次排练没有点过导入控件，也没有勾选过任何识别结果：探针里没有这两条代码路径，刹车自检（上方）是它的证据。',
  ].filter((line) => line !== '').join('\n');
}

$('copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(summarise());
  $('copied').hidden = false;
  setTimeout(() => { $('copied').hidden = true; }, 2_000);
});

$('copy-log').addEventListener('click', () => navigator.clipboard.writeText(logLines.join('\n')));

render();
