import { z } from 'zod';

// 值表示（spec #99）：金额两位小数字符串，日期 YYYY-MM-DD，时间 HH:MM，ID 为不透明字符串。
export const AmountSchema = z.string().regex(/^-?\d{1,9}\.\d{2}$/, '金额应为两位小数字符串');
export const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期应为 YYYY-MM-DD');
export const TimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, '时间应为 HH:MM');
// 时刻用 ISO 8601 本地时间（YYYY-MM-DDTHH:MM[:SS]），页面只截取到分钟显示，不做时区换算。
export const DateTimeSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?$/, '时刻应为 ISO 8601');
export const IdSchema = z.string().min(1);
export const StepTokenSchema = z.string().min(1);
export const UrlSchema = z.string().min(1);

export type Amount = z.infer<typeof AmountSchema>;
export type DateString = z.infer<typeof DateSchema>;
export type TimeString = z.infer<typeof TimeSchema>;
export type DateTimeString = z.infer<typeof DateTimeSchema>;
