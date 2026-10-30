import type { Line, SummaryData, SummaryResolution } from '@baox/contract';
import { summaryInputs } from './resolutions';
const EMPTY: SummaryResolution = { confirmationRevision: 0, voucherCounts: [], stayDays: [] };
const CATEGORIES = [
  ['住宿', '住宿费'], ['本地市内交通', '出租车费、地铁、公汽：市内'], ['外地市内交通', '出租车费、地铁、公汽：外地'], ['长途交通', '飞机、火车、长途汽车票'], ['招待费', '餐费：招待'],
] as const;
const cents = (amount: string) => Math.round(Number(amount) * 100);
export function summaryReasons(lines: readonly Line[], choices: SummaryResolution = EMPTY): string[] {
  return [
    ...lines.flatMap(line => !CATEGORIES.some(([label]) => label === line.category.label) ? [`不支持的费用类别：${line.category.label}`] : line.category.label === '住宿' && (!line.endDate || line.endDate < line.date) ? [`${line.invoiceLabel}的住宿日期无效。`] : []),
    ...summaryInputs(lines, choices).map(input => input.kind === 'stay-days' ? `${input.label}的住宿天数需要确认：同日入住离店不能自动按零天计算。` : `${input.label}跨费用类别，请先选择唯一的张数归属。`),
  ];
}
export function summaryData(lines: readonly Line[], profile: { name: string; department: string; erpAccount: string; tenant: string }, reimbursementDate: string, choices: SummaryResolution = EMPTY): SummaryData {
  const rows = CATEGORIES.map(([category, label]) => {
    const selected = lines.filter(line => line.category.label === category);
    return { category, label, amount: (selected.reduce((sum, line) => sum + cents(line.grossAmount), 0) / 100).toFixed(2), voucherCount: new Set(selected.filter(line => { const choice = choices.voucherCounts.find(item => item.voucherMaterialId === line.voucherMaterialId); return !choice || choice.category === category; }).map(line => line.voucherMaterialId)).size,
      days: category === '住宿' ? selected.reduce((sum, line) => sum + (choices.stayDays.find(item => item.lineId === line.lineId)?.days ?? (Date.parse(line.endDate ?? line.date) - Date.parse(line.date)) / 86400000), 0) : null };
  });
  return { employeeIdentity: { erpAccount: profile.erpAccount, tenant: profile.tenant }, reimbursementDate, name: profile.name, department: profile.department, billIdentifier: '', businessTripIdentifier: '', rows, total: (lines.reduce((sum, line) => sum + cents(line.grossAmount), 0) / 100).toFixed(2), totalVouchers: new Set(lines.map(line => line.voucherMaterialId)).size };
}
