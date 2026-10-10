import { cents, money } from '../../money-date';
import { compact, joinedRows, matchSpan, matchWidestSpan, type ParseDoc } from '../doc';
import { ruleSource, type Candidate, type Layout } from '../layout';
import type { SlotFormat } from '../slots';

const SOURCE = ruleSource('dining_receipt', 'labelled');
const VERSION = '2';
const TITLE = /^(小票|餐饮小票|结账单|消费小票|消费清单|顾客联)$/;
const HOTEL = /(?:^|[,;，；])(入住日期|到店日期|抵店日期|离店日期|退房日期|房号|房间号)(?=:|[0-9A-Za-z]|$)/;
const COMPLETE_SCALAR_FIELDS = /^(?:[^:0-9]+:[A-Za-z0-9]+(?:[._/-][A-Za-z0-9]+)*)+$/;
const PAID_LABELS = [['实付金额', '实付'], ['实收金额', '实收'], ['应付金额', '应付'], ['合计']];

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

type Run = ParseDoc['observations'][number];
type AmountRead = { kind: 'absent' } | { kind: 'unreadable' } | { kind: 'value'; value: string; runs: Run[] };

function aligned(a: Run, b: Run): boolean {
  return Math.abs(a.y + a.height / 2 - b.y - b.height / 2) <= Math.min(a.height, b.height) / 4;
}

function blocks(runs: Run[]): Run[][] {
  const result: Run[][] = [];
  let previous: Run | undefined;
  for (const run of runs) {
    const last = result.at(-1);
    if (last && previous && run.x - previous.x - previous.width <= Math.min(previous.height, run.height) * 1.5) last.push(run);
    else result.push([run]);
    previous = run;
  }
  return result;
}

function labelledAmount(doc: ParseDoc, aliases: readonly string[]): AmountRead {
  const pattern = new RegExp(`^(?:${aliases.join('|')})(?:[:,](.*)|([¥￥]?\\d[\\d,.]*元?)|)$`);
  const page = doc.observations.filter((run) => run.page === 1);
  const occurrences: AmountRead[] = [];
  for (const start of page) {
    const band = page.filter((run) => aligned(start, run)).sort((a, b) => a.x - b.x);
    const block = blocks(band).find((runs) => runs.includes(start));
    if (!block) continue;
    const prefix = compact(block.slice(0, block.indexOf(start)).map((run) => run.text).join(''));
    if (prefix && !COMPLETE_SCALAR_FIELDS.test(prefix)) continue;
    const [firstBlock, ...valueBlocks] = blocks(band.filter((run) => run.x >= start.x));
    if (!firstBlock) continue;
    let label: { runs: Run[]; inline: string } | undefined;
    for (let length = 1; length <= firstBlock.length; length += 1) {
      const runs = firstBlock.slice(0, length);
      const match = compact(runs.map((run) => run.text).join('')).match(pattern);
      if (match) label = { runs, inline: match[1] ?? match[2] ?? '' };
    }
    if (!label) continue;
    const { runs: labelRuns, inline } = label;
    const remaining = firstBlock.slice(labelRuns.length);
    if (remaining.length) valueBlocks.unshift(remaining);
    if (inline) {
      const value = remaining.length ? null : valueOf(inline, 'money');
      occurrences.push(value === null ? { kind: 'unreadable' } : { kind: 'value', value, runs: labelRuns });
      continue;
    }
    const amounts: { value: string; runs: Run[] }[] = [];
    for (const runs of valueBlocks) {
      const printed = compact(runs.map((run) => run.text).join(''));
      const value = valueOf(printed, 'money');
      if (value === null) break;
      amounts.push({ value, runs });
    }
    const [amount] = amounts;
    occurrences.push(amounts.length === 1 && amount ? { kind: 'value', value: amount.value, runs: [...labelRuns, ...amount.runs] } : { kind: 'unreadable' });
  }
  const [first] = occurrences;
  if (!first) return { kind: 'absent' };
  if (first.kind !== 'value') return { kind: 'unreadable' };
  const runs: Run[] = [];
  for (const occurrence of occurrences) {
    if (occurrence.kind !== 'value' || occurrence.value !== first.value) return { kind: 'unreadable' };
    runs.push(...occurrence.runs);
  }
  return { kind: 'value', value: first.value, runs };
}

export const diningReceipt: Layout = {
  kind: 'dining_receipt', name: 'labelled', version: VERSION, label: '餐饮小票',
  recognise(doc) {
    const lines = joinedRows(doc);
    return matchSpan(lines, TITLE) !== null && !doc.observations.some((observation) => HOTEL.test(compact(observation.text)))
      && ![...new Set(doc.observations.map((observation) => observation.page))].some((page) => joinedRows(doc, page).some((row) => HOTEL.test(row.text) || matchSpan([row], HOTEL) !== null))
      && PAID_LABELS.some((aliases) => labelledAmount(doc, aliases).kind !== 'absent');
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
        if (value) candidates.push({ key, value, source: SOURCE, parserVersion: VERSION, evidence: 'explicit', refs: [{ page: found.span.page, observationIds: found.span.observations.map((observation) => observation.id), text: found.span.observations.map((observation) => observation.raw).join(' ') }] });
        return;
      }
    };
    read('merchantName', ['商户', '店名']);
    read('receiptDate', ['日期', '消费日期'], 'date');
    read('receiptTime', ['时间', '消费时间']);
    const readAmount = (key: string, groups: readonly (readonly string[])[]) => {
      for (const aliases of groups) {
        const found = labelledAmount(doc, aliases);
        if (found.kind === 'absent') continue;
        if (found.kind === 'value') candidates.push({ key, value: found.value, source: SOURCE, parserVersion: VERSION, evidence: 'explicit', refs: [{ page: 1, observationIds: found.runs.map((run) => run.id), text: found.runs.map((run) => run.raw).join(' ') }] });
        return;
      }
    };
    readAmount('paidAmount', PAID_LABELS);
    readAmount('originalTotal', [['原价合计'], ['合计']]);
    readAmount('discount', [['优惠'], ['折扣']]);
    return { kindLabel: '餐饮小票', candidates, findings: [] };
  },
};
