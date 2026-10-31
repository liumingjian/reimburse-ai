import type { SummaryData } from '@baox/contract';
import { CURRENCY_FORMULA } from './currency-formula';

type SummaryCell = { address: string; display: string } & (
  | { kind: 'value'; value: string | number }
  | { kind: 'formula'; formula: string }
);
const ROW_CELLS: readonly (readonly [amount: string, vouchers: string])[] = [
  ['F6', 'D6'], ['F7', 'D7'], ['F8', 'D8'], ['K6', 'I6'], ['F9', 'D9'],
];

function uppercase(amount: string): string {
  const digits = '零壹贰叁肆伍陆柒捌玖';
  const total = Math.round(Number(amount) * 100);
  const integer = Math.floor(total / 100);
  const group = (n: number): string => {
    let text = ''; let zero = false;
    for (let pos = 3; pos >= 0; pos -= 1) {
      const digit = Math.floor(n / 10 ** pos) % 10;
      if (digit) { if (zero && text) text += '零'; text += `${digits[digit]}${['', '拾', '佰', '仟'][pos]}`; zero = false; } else if (text) zero = true;
    }
    return text;
  };
  let yuan = ''; let pendingZero = false;
  for (const [scale, unit] of [[100000000, '亿'], [10000, '万'], [1, '']] as const) {
    const n = Math.floor(integer / scale) % (scale === 100000000 ? 100000000 : 10000);
    if (n) { if (yuan && (pendingZero || n < 1000)) yuan += '零'; yuan += group(n) + unit; pendingZero = false; } else if (yuan) pendingZero = true;
  }
  const jiao = Math.floor(total / 10) % 10; const fen = total % 10;
  return `${yuan || '零'}元${!jiao && !fen ? '整' : `${jiao ? `${digits[jiao]}角` : integer && fen ? '零' : ''}${fen ? `${digits[fen]}分` : ''}`}`;
}

export function summaryCells(data: SummaryData): SummaryCell[] {
  const text = (address: string, value: string): SummaryCell => ({ address, kind: 'value', value, display: value });
  const number = (address: string, value: number, display = String(value)): SummaryCell => ({ address, kind: 'value', value, display });
  const cells: SummaryCell[] = [
    text('C4', data.name), text('F4', data.department), text('H3', '报销日期'),
    number('I3', (Date.parse(`${data.reimbursementDate}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000, data.reimbursementDate),
    text('C3', data.billIdentifier), text('F3', data.businessTripIdentifier),
  ];
  data.rows.forEach((row, index) => {
    const addresses = ROW_CELLS[index];
    if (!addresses || !(row.voucherCount || Number(row.amount))) return;
    cells.push(number(addresses[0], Number(row.amount), row.amount), number(addresses[1], row.voucherCount));
    if (row.days !== null) cells.push(number('E6', row.days));
  });
  cells.push(
    { address: 'D17', kind: 'formula', formula: 'ROUND(SUM(F6:F16,K6:K9),2)', display: data.total },
    { address: 'B18', kind: 'formula', formula: CURRENCY_FORMULA, display: uppercase(data.total) },
  );
  return cells;
}
