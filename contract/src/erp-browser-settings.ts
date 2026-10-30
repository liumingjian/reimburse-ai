import { z } from 'zod';
import type { ActionError } from './actions';

export const ERP_BROWSER_MODES = ['headless', 'headed'] as const;
export const ErpBrowserModeSchema = z.enum(ERP_BROWSER_MODES);
export type ErpBrowserMode = z.infer<typeof ErpBrowserModeSchema>;

export const ErpBrowserSettingsSchema = z.object({ browserMode: ErpBrowserModeSchema });
export type ErpBrowserSettings = z.infer<typeof ErpBrowserSettingsSchema>;
export const SaveErpBrowserSettingsInputSchema = ErpBrowserSettingsSchema;
export type SaveErpBrowserSettingsInput = ErpBrowserSettings;

export type ErpBrowserSettingsOutcome =
  | { ok: true; settings: ErpBrowserSettings }
  | { ok: false; error: ActionError; settings: ErpBrowserSettings | null };
