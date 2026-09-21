import { DEFAULT_ERP_ORIGIN } from '@baox/erp-executor/probe';
import type { Compatibility } from '@baox/erp-executor/protocol';

// Where the fill job writes and which ERP build it may write to. The compatibility fingerprint aborts a job before
// any attempt when ERP was upgraded under us (ADR-0016).
//
// Verified against the live ERP on 2026-09-19 (`probe.ts` COMPATIBILITY_SNIPPET carries what the probe corrected).
// The build moves with every K3Cloud patch, and a moved build is exactly what this fingerprint is meant to catch:
// the job aborts before any attempt and a human re-verifies. `BAOX_ERP_BUILD` / `BAOX_ERP_FORM_ID` override it.

export type ErpConfig = { origin: string; compatibility: Compatibility };

export const DEFAULT_ERP_CONFIG: ErpConfig = {
  origin: DEFAULT_ERP_ORIGIN,
  compatibility: { erpBuild: '8.2.830.9', formId: 'ER_ExpReimbursement' },
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
