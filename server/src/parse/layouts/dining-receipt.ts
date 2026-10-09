import { cents, money } from '../../money-date';
import { joinedRows, matchSpan, matchWidestSpan } from '../doc';
import { ruleSource, type Candidate, type Layout } from '../layout';
import type { SlotFormat } from '../slots';

const SOURCE = ruleSource('dining_receipt', 'labelled');
const TITLE = /^(小票|餐饮小票|结账单|消费小票|消费清单|顾客联)$/;
const HOTEL = /(?:^|[,;，；])(入住日期|到店日期|抵店日期|离店日期|退房日期|房号|房间号)(?=:|$)/;
const PAID_LABELS = ['实付', '实收', '应付', '合计'] as const;

function valueOf(printed: string, format: SlotFormat): string | null {
  if (format === 'money') {
    const amount = cents(printed.replace(/元$/, ''));
    return amount === null ? null : money(amount);
  }
  if (format === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(printed)) return null;
    const date = new Date(`${printed}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === printed ? printed : null;
  }
  return printed;
}

export const diningReceipt: Layout = {
  kind: 'dining_receipt', name: 'labelled', version: '1', label: '餐饮小票',
  recognise(doc) {
    const lines = joinedRows(doc);
    return matchSpan(lines, TITLE) !== null && matchSpan(lines, HOTEL) === null
      && PAID_LABELS.some((label) => matchSpan(lines, new RegExp(`^${label}(?::.*)?$`)) !== null);
  },
  parse(doc) {
    const lines = joinedRows(doc);
    const candidates: Candidate[] = [];
    const read = (key: string, labels: readonly string[], format: SlotFormat = 'text') => {
      for (const label of labels) {
        if (!matchSpan(lines, new RegExp(`^${label}(?::.*)?$`))) continue;
        const found = matchWidestSpan(lines, new RegExp(`^${label}:?(.+)$`));
        if (!found) return;
        const printed = found.match[1] ?? '';
        const value = valueOf(printed, format);
        if (value) candidates.push({ key, value, source: SOURCE, parserVersion: '1', evidence: 'explicit', refs: [{ page: found.span.page, observationIds: found.span.observations.map((observation) => observation.id), text: found.span.observations.map((observation) => observation.raw).join(' ') }] });
        return;
      }
    };
    read('merchantName', ['商户', '店名']);
    read('receiptDate', ['日期', '消费日期'], 'date');
    read('receiptTime', ['时间', '消费时间']);
    read('paidAmount', PAID_LABELS, 'money');
    read('originalTotal', ['原价合计', '合计'], 'money');
    read('discount', ['优惠', '折扣'], 'money');
    return { kindLabel: '餐饮小票', candidates, findings: [] };
  },
};
