// The two pure judgments the money path rests on, tested directly because the job-level tests can only reach one
// of them at a time: the gate refuses first, so the witness behind it would otherwise never be exercised.
//
// Both read ERP's own computed 申请报销金额 (claimed amount), and they ask different questions of it:
//   - `moneyModelSettled` asks whether ERP AGREES WITH ITSELF — has the model taken what the cells show? It is
//     the gate between the two money writes of one row (ledger V-59: the model trails the cell by ~260ms and a
//     write issued inside that window is dropped).
//   - `computedTotalProblem` asks whether ERP agrees with THE PLAN — are the numbers the ones baox meant to
//     write, and does ERP's own column equal their sum? It is the backstop after the row is written.
// A row can settle and still be wrong (ERP took a value nobody asked for), which is why the second one stays.
import { describe, expect, it } from 'vitest';
import { computedTotalProblem, moneyModelSettled } from './draft-flow';

const row = (net: string, tax: string, sum: string) => ({ 费用金额: net, 税额: tax, 申请报销金额: sum });

describe('moneyModelSettled — has ERP taken what the cells show', () => {
  it('agrees when the computed column equals the pair', () => {
    expect(moneyModelSettled(row('¥1,677.36', '¥100.64', '¥1,778.00'))).toBe(true);
  });

  // The measured shape right after 费用金额 commits: 税额 has been cleared, and ERP settles on the net alone.
  it('treats an empty 税额 as zero, which is how ERP settles a freshly written 费用金额', () => {
    expect(moneyModelSettled(row('¥1,677.36', '', '¥1,677.36'))).toBe(true);
  });

  // t=2ms after 税额 commits: the cell has it, 申请报销金额 is still the net alone. This is the state the gate
  // exists to wait out — and the state a fill must never type the next money cell in.
  it('refuses while the cell has the tax and the computed column does not', () => {
    expect(moneyModelSettled(row('¥1,677.36', '¥100.64', '¥1,677.36'))).toBe(false);
  });

  it('refuses when the computed column cannot be read at all', () => {
    expect(moneyModelSettled(row('¥32.18', '¥0.32', ''))).toBe(false);
  });

  // An untouched row is not an unsettled one: nothing has been written, so there is nothing to wait for.
  it('lets an empty row count as settled', () => {
    expect(moneyModelSettled(row('', '', ''))).toBe(true);
    expect(moneyModelSettled(undefined)).toBe(true);
  });
});

describe('computedTotalProblem — does ERP agree with the plan', () => {
  const planned = { net: '1677.36', tax: '100.64' };

  it('passes a row whose cells match the plan and whose computed column is their sum', () => {
    expect(computedTotalProblem(row('¥1,677.36', '¥100.64', '¥1,778.00'), planned, '明细第 1 行')).toBeNull();
  });

  // The case the gate cannot see: ERP agrees with itself, and on a number nobody asked it to write.
  it('rejects a row that is self-consistent but not the planned amount', () => {
    const problem = computedTotalProblem(row('¥1,600.00', '¥100.64', '¥1,700.64'), planned, '明细第 1 行');
    expect(problem).toContain('不是要写的 1677.36');
  });

  it('rejects a row whose computed column is not the sum of its own cells', () => {
    const problem = computedTotalProblem(row('¥1,677.36', '¥100.64', '¥1,677.36'), planned, '明细第 11 行');
    expect(problem).toContain('明细第 11 行');
    expect(problem).toContain('申请报销金额');
  });

  it('refuses to call a row written when its money cells do not read as money', () => {
    expect(computedTotalProblem(row('', '', ''), planned, '明细第 1 行')).toContain('读不出金额');
  });

  it('says so when ERP computed nothing at all', () => {
    const problem = computedTotalProblem(row('¥1,677.36', '¥100.64', ''), planned, '明细第 1 行');
    expect(problem).toContain('没有算出这一行的金额');
  });
});
