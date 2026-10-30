import type { Line, SummaryData } from '@baox/contract';
const CATEGORIES = [
  ['住宿', '住宿费'], ['本地市内交通', '出租车费、地铁、公汽：市内'], ['外地市内交通', '出租车费、地铁、公汽：外地'], ['长途交通', '飞机、火车、长途汽车票'], ['招待费', '餐费：招待'],
] as const;
const cents = (amount: string) => Math.round(Number(amount) * 100);
export function summaryReasons(lines: readonly Line[]): string[] {
  const reasons: string[] = [];
  const vouchers = new Map<string, Set<string>>();
  for (const line of lines) {
    const categories = vouchers.get(line.voucherMaterialId) ?? new Set<string>(); categories.add(line.category.label); vouchers.set(line.voucherMaterialId, categories);
    if (!CATEGORIES.some(([label]) => label === line.category.label)) reasons.push(`不支持的费用类别：${line.category.label}`);
    if (line.category.label === '住宿' && (!line.endDate || line.endDate <= line.date)) reasons.push(`${line.invoiceLabel}的住宿天数需要确认：同日入住离店不能自动按零天计算。`);
  }
  for (const [id, categories] of vouchers) if (categories.size > 1) reasons.push(`凭证 ${id} 跨费用类别，请先选择唯一的张数归属。`);
  return reasons;
}
export function summaryData(lines: readonly Line[], profile: { name: string; department: string; erpAccount: string; tenant: string }, reimbursementDate: string): SummaryData {
  const rows = CATEGORIES.map(([category, label]) => {
    const selected = lines.filter(line => line.category.label === category);
    return { category, label, amount: (selected.reduce((sum, line) => sum + cents(line.grossAmount), 0) / 100).toFixed(2), voucherCount: new Set(selected.map(line => line.voucherMaterialId)).size,
      days: category === '住宿' ? selected.reduce((sum, line) => sum + (Date.parse(line.endDate ?? line.date) - Date.parse(line.date)) / 86400000, 0) : null };
  });
  return { employeeIdentity: { erpAccount: profile.erpAccount, tenant: profile.tenant }, reimbursementDate, name: profile.name, department: profile.department, billIdentifier: '', businessTripIdentifier: '', rows, total: (lines.reduce((sum, line) => sum + cents(line.grossAmount), 0) / 100).toFixed(2), totalVouchers: new Set(lines.map(line => line.voucherMaterialId)).size };
}
