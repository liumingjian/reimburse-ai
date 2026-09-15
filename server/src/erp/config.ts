import { DEFAULT_ERP_ORIGIN } from './executor/probe';
import type { Compatibility } from './protocol';

// Where the fill job writes and which ERP build it may write to. The compatibility fingerprint aborts a job before
// any attempt when ERP was upgraded under us (ADR-0016).
//
// UNVERIFIED on the live ERP: the build string and the selectors that read it (`probe.ts` COMPATIBILITY_SNIPPET).
// `pnpm test:erp-live` confirms them; until then `BAOX_ERP_BUILD` / `BAOX_ERP_FORM_ID` override the defaults.

export type ErpConfig = { origin: string; compatibility: Compatibility };

export const DEFAULT_ERP_CONFIG: ErpConfig = {
  origin: DEFAULT_ERP_ORIGIN,
  compatibility: { erpBuild: '8.2.0.20250701', formId: 'ER_ExpReimbursement' },
};

export function erpConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ErpConfig {
  return {
    origin: env['BAOX_ERP_ORIGIN'] || DEFAULT_ERP_CONFIG.origin,
    compatibility: {
      erpBuild: env['BAOX_ERP_BUILD'] || DEFAULT_ERP_CONFIG.compatibility.erpBuild,
      formId: env['BAOX_ERP_FORM_ID'] || DEFAULT_ERP_CONFIG.compatibility.formId,
    },
  };
}
