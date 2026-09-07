import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

// 逐段分摊问到终端上：一轮至多四题，答案先落草稿，齐了才提交，
// 而且提交的门槛和分摊页完全一样 —— 各段之和与票面价税合计按分精确相等。
//
// 这一层测的是**问答的机制**（问哪几段、答案怎么落、对不上怎么退），
// 不测措辞（那在 next.test.mjs），也不测端到端（那在 next-erp.test.mjs）。
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-alloc-'));
process.env.BAOX_HOME = home;

const { parseMaterial } = await import('../src/parse.mjs');
const { buildEvents, ALLOCATION_KINDS } = await import('../src/events.mjs');
const { allocationRound, receiveAllocationAnswers, givenUpOpenItems, loadDraft, MAX_QUESTIONS }
  = await import('../src/allocate.mjs');
const { createTask } = await import('../src/workspace.mjs');

const repo = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const AA_INV = '交通/【AA出行-69.19元-3个行程】高德打车电子发票.pdf';
const AA_ITI = '交通/【AA出行-69.19元-3个行程】高德打车电子行程单.pdf';

const load = (id, rel) => ({
  materialId: id, fileName: path.basename(rel), contentHash: `hash-${id}`,
  ...parseMaterial(path.join(repo, 'resources', rel), 'pdf'),
});

/** 行程单逐段之和与票面对不上的那张合并发票 —— 只有这种才会问用户。 */
function skewed(rows = null) {
  const c = { versionId: 'v-test', duplicates: [],
    results: [load('m-inv', AA_INV), load('m-iti', AA_ITI)] };
  const segs = c.results[1].candidates.find((x) => x.field === 'segments');
  segs.value = rows ?? segs.value.map((s, i) => (i === 0 ? { ...s, amount: '26.70' } : s));
  return c;
}

const task = () => createTask(fs.mkdtempSync(path.join(os.tmpdir(), 'baox-src-')));
const notesOf = (built) => built.notes.filter((n) => ALLOCATION_KINDS.has(n.kind));
const voucherOf = (c) => c.results.find((r) => r.materialId === 'm-inv');

test('三段就问三题：每题带着行程单那一行的候选，末项恒为「其他」', () => {
  const t = task();
  const c = skewed();
  const r = allocationRound(t, notesOf(buildEvents(c, t)));
  assert.equal(r.materialId, 'm-inv');
  assert.equal(r.segmentCount, 3);
  assert.equal(r.totalAmount, '69.19');
  assert.equal(r.questions.length, 3);
  assert.deepEqual(r.questions.map((q) => q.id), ['m-inv#1', 'm-inv#2', 'm-inv#3']);
  assert.equal(r.questions[0].options[0].label, '26.70', '行程单上写的那个数是候选，不是答案');
  assert.equal(r.questions[0].options.at(-1).label, '其他');
  assert.ok(r.questions.every((q) => q.options.length >= 2 && q.options.length <= 4));
});

test('三段答齐、加起来正好是票面价税合计 —— 收下，明细当场变成三行', () => {
  const t = task();
  const c = skewed();
  const r = allocationRound(t, notesOf(buildEvents(c, t)));
  const got = receiveAllocationAnswers(t, r, voucherOf(c), { answers: [
    { questionId: 'm-inv#1', amount: '26.69' },
    { questionId: 'm-inv#2', amount: '20.85' },
    { questionId: 'm-inv#3', amount: '21.65' },
  ] });
  assert.equal(got.verdict, 'allocated');
  assert.deepEqual(got.amounts, ['26.69', '20.85', '21.65']);

  const built = buildEvents(c, t);
  assert.equal(built.events.length, 3);
  assert.deepEqual(built.events.map((e) => e.amountSource), Array(3).fill('user_allocation'));
  assert.deepEqual(notesOf(built), [], '收下之后就不该再问了');
  assert.equal(allocationRound(t, notesOf(built)), null);
});

test('差一分不收：整轮退回重问，差多少原样带着', () => {
  const t = task();
  const c = skewed();
  const r = allocationRound(t, notesOf(buildEvents(c, t)));
  const got = receiveAllocationAnswers(t, r, voucherOf(c), { answers: [
    { questionId: 'm-inv#1', amount: '26.70' },
    { questionId: 'm-inv#2', amount: '20.85' },
    { questionId: 'm-inv#3', amount: '21.65' },
  ] });
  assert.equal(got.verdict, 'rejected');
  assert.match(got.reasons.join(), /差 0\.01/);

  // 分摊没落盘，明细一行都没多；下一轮从头问，并且带着上一次没收下的理由。
  const built = buildEvents(c, t);
  assert.equal(built.events.length, 0);
  const again = allocationRound(t, notesOf(built));
  assert.equal(again.questions.length, 3, '整张重问 —— 内核不去猜是哪一段错了');
  assert.match(again.rejection.reasons.join(), /差 0\.01/);
});

test('金额格式不合法的那一题单独退回，别的答案留在草稿里', () => {
  const t = task();
  const c = skewed();
  const r = allocationRound(t, notesOf(buildEvents(c, t)));
  const got = receiveAllocationAnswers(t, r, voucherOf(c), { answers: [
    { questionId: 'm-inv#1', amount: '二十六块七' },
    { questionId: 'm-inv#2', amount: '20.85' },
    { questionId: 'm-inv#3', amount: '21.65' },
  ] });
  assert.equal(got.verdict, 'rejected');
  assert.match(got.reasons.join(), /不合规矩/);
  const draft = loadDraft(t, 'm-inv', voucherOf(c).contentHash);
  assert.equal(draft.amounts['1'], '20.85', '答得好好的那两段没必要让用户再说一遍');
});

test('段数多于四段时分轮问，中途的答案留得住', () => {
  const t = task();
  // 五段，加起来仍然不是 69.19 —— 所以要问用户。
  const rows = ['10.00', '10.00', '10.00', '10.00', '10.00'].map((amount, i) =>
    ({ date: '2026-07-09', city: '北京市', route: `第 ${i + 1} 程`, amount }));
  const c = skewed(rows);
  const first = allocationRound(t, notesOf(buildEvents(c, t)));
  assert.equal(first.segmentCount, 5);
  assert.equal(first.questions.length, MAX_QUESTIONS, '一轮至多四题，这是契约里的硬上限');
  assert.equal(first.remaining, 5);

  const drafted = receiveAllocationAnswers(t, first, voucherOf(c), { answers: [
    { questionId: 'm-inv#1', amount: '13.00' },
    { questionId: 'm-inv#2', amount: '14.00' },
    { questionId: 'm-inv#3', amount: '15.00' },
    { questionId: 'm-inv#4', amount: '16.00' },
  ] });
  assert.equal(drafted.verdict, 'drafted');
  assert.equal(drafted.answered, 4);

  const second = allocationRound(t, notesOf(buildEvents(c, t)));
  assert.deepEqual(second.questions.map((q) => q.id), ['m-inv#5'], '只问还没答的那一段');
  assert.equal(second.answered.length, 4, '前四段摆出来给用户看，最后一段他才算得清');

  const done = receiveAllocationAnswers(t, second, voucherOf(c), {
    answers: [{ questionId: 'm-inv#5', amount: '11.19' }] });
  assert.equal(done.verdict, 'allocated', '13 + 14 + 15 + 16 + 11.19 = 69.19');
  assert.equal(buildEvents(c, t).events.length, 5);
});

test('用户说「这张票我认不出」—— 整张退回待办，不再追问', () => {
  const t = task();
  const c = skewed();
  const r = allocationRound(t, notesOf(buildEvents(c, t)));
  const got = receiveAllocationAnswers(t, r, voucherOf(c), {
    answers: [{ questionId: 'm-inv#1', giveUp: true }] });
  assert.equal(got.verdict, 'gave_up');

  const notes = notesOf(buildEvents(c, t));
  assert.equal(allocationRound(t, notes), null, '认不出之后不再问同一张票');
  const items = givenUpOpenItems(t, notes);
  assert.equal(items.length, 1);
  assert.equal(items[0].blocking, true, '拆不出来的合并发票不能带着往 ERP 走');
  assert.match(items[0].note, /行程单|挪出/, '解法在用户那一侧，要说清楚是什么');
});

test('答的不是这一轮问的题，不悄悄丢掉，也不算数', () => {
  const t = task();
  const c = skewed();
  const r = allocationRound(t, notesOf(buildEvents(c, t)));
  const got = receiveAllocationAnswers(t, r, voucherOf(c), {
    answers: [{ questionId: 'm-inv#9', amount: '26.69' }] });
  assert.equal(got.verdict, 'rejected');
  assert.match(got.reasons.join(), /不是这一轮问的题/);
});

test('发票换了字节，草稿当场作废 —— 半份答案不会落到另一张票上', () => {
  const t = task();
  const c = skewed();
  const rows = allocationRound(t, notesOf(buildEvents(c, t)));
  receiveAllocationAnswers(t, rows, voucherOf(c), {
    answers: [{ questionId: 'm-inv#1', amount: '26.69' }] });
  assert.ok(loadDraft(t, 'm-inv', 'hash-m-inv'));
  assert.equal(loadDraft(t, 'm-inv', 'hash-changed'), null);
});

test('「我认不出」写成整份文件顶上一个 giveUp 也算数', () => {
  // 内核给模型的 answersFormat 把它写在 answers 里，但模型换一种写法交上来时，
  // 用户的表态不能被判成"这几段没答"然后**悄悄丢掉**。
  const t = task();
  const c = skewed();
  const r = allocationRound(t, notesOf(buildEvents(c, t)));
  const got = receiveAllocationAnswers(t, r, voucherOf(c), { giveUp: true, answers: [] });
  assert.equal(got.verdict, 'gave_up');
  assert.equal(allocationRound(t, notesOf(buildEvents(c, t))), null);
});

test('0.00 也不是一个合法的段金额 —— 问和收用的是同一条规矩', () => {
  const t = task();
  const c = skewed();
  const r = allocationRound(t, notesOf(buildEvents(c, t)));
  const got = receiveAllocationAnswers(t, r, voucherOf(c), { answers: [
    { questionId: 'm-inv#1', amount: '0.00' },
    { questionId: 'm-inv#2', amount: '47.54' },
    { questionId: 'm-inv#3', amount: '21.65' },
  ] });
  assert.equal(got.verdict, 'rejected', '收下一个 0 元的行程段，等于把一段行程悄悄抹掉');
  assert.match(got.reasons.join(), /不合规矩/);
});

test.after(() => { fs.rmSync(home, { recursive: true, force: true }); });
