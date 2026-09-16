// Checks the QA driver's manual-fill values against the app's own format rules, without a browser:
//   node --test "qa/*.test.mjs"
// Deliberately not part of `pnpm test`: the driver is an operator tool, not a CI job.
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AMOUNT_PATTERN, TIME_PATTERN, qaValue } from './values.mjs';

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
