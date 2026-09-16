// Checks the QA driver's manual-fill values against the app's own format rules, without a browser:
//   node --test "qa/*.test.mjs"
// Deliberately not part of `pnpm test`: the driver is an operator tool, not a CI job.
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AMOUNT_PATTERN, TIME_PATTERN, amountTriple, qaSelfCheck, qaValue, toCents } from './values.mjs';

const repo = new URL('..', import.meta.url);
const read = (path) => readFile(fileURLToPath(new URL(path, repo)), 'utf8');

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Every slot the app can ask a user to fill, read from the kind schemas so a new slot is covered the day
// it is added: `{ key: 'totalAmount', label: '价税合计', required: true, format: 'money' },`.
async function slots() {
  const source = await read('server/src/parse/kinds.ts');
  const found = [...source.matchAll(/\{ key: '([^']+)', label: '([^']+)', required: (?:true|false), format: '([^']+)' \}/g)];
  return found.map(([, key, label, format]) => ({ key, label, format }));
}

test('the copied format patterns still match the contract', async () => {
  const contract = await read('contract/src/actions.ts');
  assert.ok(contract.includes(`const TIME_PATTERN = /${TIME_PATTERN.source}/;`), 'TIME_PATTERN drifted from the contract');
  assert.ok(contract.includes(`const AMOUNT_PATTERN = /${AMOUNT_PATTERN.source}/;`), 'AMOUNT_PATTERN drifted from the contract');
});

test('every declared slot gets a value its format accepts', async () => {
  const all = await slots();
  assert.ok(all.length > 20, `expected the kind schemas to declare slots, read ${all.length}`);
  for (const slot of all) {
    const value = qaValue(slot);
    assert.notEqual(value, '', `${slot.key} got an empty value`);
    if (slot.format === 'money') {
      assert.match(value, AMOUNT_PATTERN, `${slot.key} (${slot.label})`);
      // 逐段分摊 additionally rejects a zero amount (contract/src/actions.ts).
      assert.notEqual(value, '0.00', `${slot.key} (${slot.label})`);
    }
    if (slot.format === 'time') assert.match(value, TIME_PATTERN, `${slot.key} (${slot.label})`);
    if (slot.format === 'date') assert.match(value, DATE_PATTERN, `${slot.key} (${slot.label})`);
  }
});

test('a money label is answered with an amount even when the page gives no format', () => {
  for (const label of ['价税合计', '票价', '金额', '不含税金额', '税额', '消费合计', '房价', '已付款']) {
    const value = qaValue({ label });
    assert.match(value, AMOUNT_PATTERN, label);
    assert.notEqual(value, '0.00', label);
  }
});

test('a date or time label is answered in its format even with no declared format', () => {
  assert.match(qaValue({ label: '乘车日期' }), DATE_PATTERN);
  assert.match(qaValue({ label: '开车时间' }), TIME_PATTERN);
});

test('an unknown text field falls back to a marker, not to an amount-shaped value', () => {
  assert.equal(qaValue({ key: 'somethingNew', label: '某个新字段' }), 'QA');
});

test('the segment amounts of 逐段分摊 are positive two-decimal amounts', () => {
  const value = qaValue({ key: 'segments[0].amount', label: '第 1 段价税合计', format: 'money' });
  assert.match(value, AMOUNT_PATTERN);
  assert.notEqual(value, '0.00');
});

// --- conservation: 不含税金额 + 税额 = 价税合计 -------------------------------------------------
// The server refuses any other triple and never back-calculates one (ADR-0017), so the driver's values
// have to add up on their own or a real pass can never get past a 缺少字段 form.

const VAT_AMOUNTS = ['netAmount', 'taxAmount', 'totalAmount'];
const amountsOf = (total) =>
  Object.fromEntries(VAT_AMOUNTS.map((key) => [key, qaValue({ key, label: key, format: 'money', kind: 'vat_invoice', total })]));

test('the copied conservation check still matches the server', async () => {
  const kinds = await read('server/src/parse/kinds.ts');
  assert.ok(kinds.includes('系统不会倒算或调整任何金额'), 'the conservation check moved or changed its wording');
  assert.ok(kinds.includes("if (n !== null && t !== null && g !== null && n + t !== g)"), 'the conservation check changed shape');
});

test('a form asking for all three amounts is answered with a triple that conserves', () => {
  const values = amountsOf(undefined);
  for (const key of VAT_AMOUNTS) {
    assert.match(values[key], AMOUNT_PATTERN, key);
    assert.notEqual(values[key], '0.00', key);
  }
  assert.equal(toCents(values['netAmount']) + toCents(values['taxAmount']), toCents(values['totalAmount']));
  assert.equal(qaSelfCheck(values, 'vat_invoice'), null);
});

test('when the 价税合计 is already read, the two filled amounts add up to it', () => {
  for (const total of ['0.01', '0.02', '1.00', '19.90', '20.00', '69.19', '226.42', '1234.56', '99999.99']) {
    const net = qaValue({ key: 'netAmount', label: '不含税金额', format: 'money', total });
    const tax = qaValue({ key: 'taxAmount', label: '税额', format: 'money', total });
    assert.match(net, AMOUNT_PATTERN, total);
    assert.match(tax, AMOUNT_PATTERN, total);
    assert.equal(toCents(net) + toCents(tax), toCents(total), `${net} + ${tax} != ${total}`);
    // Merged with the already-read total, the submission is what the server checks.
    assert.equal(qaSelfCheck({ netAmount: net, taxAmount: tax, totalAmount: total }, 'vat_invoice'), null, total);
  }
});

test('a total the driver cannot use falls back to a consistent triple, never to unrelated constants', () => {
  for (const total of [undefined, '', 'n/a', '20', '1,234.00', '-5.00']) {
    const values = amountsOf(total);
    assert.equal(toCents(values['netAmount']) + toCents(values['taxAmount']), toCents(values['totalAmount']), String(total));
  }
});

test('both parts of the triple stay positive whenever the total leaves room', () => {
  for (const total of ['0.02', '0.50', '20.00', '9999.00']) {
    const { net, tax } = amountTriple(total);
    assert.notEqual(net, '0.00', total);
    assert.notEqual(tax, '0.00', total);
  }
});

test('the invoice number matches the shape its kind is checked against', () => {
  assert.equal(qaSelfCheck({ invoiceNumber: qaValue({ key: 'invoiceNumber', label: '发票号码' }) }, 'vat_invoice'), null);
  assert.equal(qaSelfCheck({ invoiceNumber: qaValue({ key: 'invoiceNumber', label: '发票号码' }) }, 'rail_ticket'), null);
  const taxi = {
    invoiceNumber: qaValue({ key: 'invoiceNumber', label: '发票号码', kind: 'taxi_receipt' }),
    invoiceCode: qaValue({ key: 'invoiceCode', label: '发票代码', kind: 'taxi_receipt' }),
  };
  assert.equal(qaSelfCheck(taxi, 'taxi_receipt'), null);
});

test('the self-check names the rule a refusal would cite instead of clearing the driver', () => {
  assert.match(qaSelfCheck({ netAmount: '19.00', taxAmount: '1.00', totalAmount: '69.19' }), /价税合计/);
  assert.match(qaSelfCheck({ invoiceNumber: '123' }), /发票号码/);
});

test('the stand-in 项目名称 is one the app can read a 费用类别 out of', async () => {
  const kinds = await read('server/src/parse/kinds.ts');
  for (const kind of [undefined, 'vat_invoice']) {
    const itemName = qaValue({ key: 'itemName', label: '项目名称', kind });
    const [, taxClass] = /^\*([^*]+)\*(.+)$/.exec(itemName) ?? [];
    assert.ok(taxClass, `项目名称 must keep the *类别*说明 shape, got ${itemName}`);
    assert.ok(kinds.includes(`taxClass === '${taxClass}'`), `${taxClass} is no longer a 税收分类 the app maps to a category`);
  }
});

test('two materials never get the same stand-in 发票号码', () => {
  const numberFor = (seed) => qaValue({ key: 'invoiceNumber', label: '发票号码', seed });
  const seeds = ['a', 'b', 'c8f1e2', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
  const numbers = seeds.map(numberFor);
  assert.equal(new Set(numbers).size, seeds.length, `stand-in numbers collided: ${numbers.join(' ')}`);
  for (const number of numbers) {
    assert.match(number, /^\d{20}$/);
    assert.equal(qaSelfCheck({ invoiceNumber: number }, 'vat_invoice'), null);
  }
  assert.equal(numberFor('a'), numberFor('a'), 'the same material must get the same number twice');
});
