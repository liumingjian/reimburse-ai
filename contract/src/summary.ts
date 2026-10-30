import { z } from 'zod';
import { AmountSchema, DateSchema, UrlSchema } from './primitives';
export const SummaryPrintInformationSchema = z.object({
  reimbursementDate: DateSchema.refine(value => {
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, '请输入有效的报销日期'),
  name: z.string().trim().min(1).max(100), department: z.string().trim().min(1).max(200),
  billIdentifier: z.string().trim().max(100), businessTripIdentifier: z.string().trim().max(100),
});
export type SummaryPrintInformation = z.infer<typeof SummaryPrintInformationSchema>;
export const SummaryDataSchema = z.object({
  employeeIdentity: z.object({ erpAccount: z.string(), tenant: z.string() }),
  reimbursementDate: DateSchema, name: z.string(), department: z.string(),
  billIdentifier: z.string(), businessTripIdentifier: z.string(),
  rows: z.array(z.object({ category: z.string(), label: z.string(), amount: AmountSchema, voucherCount: z.number().int().nonnegative(), days: z.number().int().nonnegative().nullable() })),
  total: AmountSchema, totalVouchers: z.number().int().nonnegative(),
});
export type SummaryData = z.infer<typeof SummaryDataSchema>;
export const ReimbursementSummarySchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('unavailable'), reasons: z.array(z.string()) }),
  z.object({ status: z.literal('ready') }),
  z.object({ status: z.literal('generated'), data: SummaryDataSchema, url: UrlSchema, previewUrl: UrlSchema, fileName: z.string() }),
]);
export type ReimbursementSummary = z.infer<typeof ReimbursementSummarySchema>;
