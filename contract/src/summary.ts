import { z } from 'zod';
import { AmountSchema, DateSchema, UrlSchema } from './primitives';
export const SummaryResolutionSchema = z.object({
  confirmationRevision: z.number().int().nonnegative(),
  voucherCounts: z.array(z.object({ voucherMaterialId: z.string(), category: z.string() })).default([]),
  stayDays: z.array(z.object({ lineId: z.string(), days: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })).default([]),
});
export type SummaryResolution = z.infer<typeof SummaryResolutionSchema>;
export const SummaryInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('voucher-count'), voucherMaterialId: z.string(), label: z.string(), categories: z.array(z.string()) }),
  z.object({ kind: z.literal('stay-days'), lineId: z.string(), label: z.string(), date: DateSchema }),
]);
export type SummaryInput = z.infer<typeof SummaryInputSchema>;
export const SummaryDataSchema = z.object({
  employeeIdentity: z.object({ erpAccount: z.string(), tenant: z.string() }),
  reimbursementDate: DateSchema, name: z.string(), department: z.string(),
  billIdentifier: z.string(), businessTripIdentifier: z.string(),
  rows: z.array(z.object({ category: z.string(), label: z.string(), amount: AmountSchema, voucherCount: z.number().int().nonnegative(), days: z.number().int().nonnegative().nullable() })),
  total: AmountSchema, totalVouchers: z.number().int().nonnegative(),
});
export type SummaryData = z.infer<typeof SummaryDataSchema>;
export const ReimbursementSummarySchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('unavailable'), reasons: z.array(z.string()), confirmationRevision: z.number().int().nonnegative().optional(), inputs: z.array(SummaryInputSchema).optional() }),
  z.object({ status: z.literal('ready') }),
  z.object({ status: z.literal('generated'), data: SummaryDataSchema, url: UrlSchema, previewUrl: UrlSchema, fileName: z.string() }),
]);
export type ReimbursementSummary = z.infer<typeof ReimbursementSummarySchema>;
