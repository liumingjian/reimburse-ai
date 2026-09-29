// The scenarios the server records a golden TaskSnapshot for (server/src/snapshot-goldens.test.ts drives each one with
// the scenario builder). Apart from index.ts so the server can name them without loading the recorded JSON.
export const GOLDEN_SCENARIOS = [
  'upload',
  'pending',
  'project',
  'review',
  'choose-action',
  'catalog-mismatch',
  'erp-login-wall',
  'erp-stopped-before-write',
  'erp-unknown',
  'reconcile-readback-mismatch',
  'done',
  'voided',
] as const;

export type GoldenScenario = (typeof GOLDEN_SCENARIOS)[number];

// Every timestamp the server stamped during a recorded scenario (createdAt, updatedAt, uploadedAt, …) reads this.
export const GOLDEN_TIME = '2000-01-01T00:00:00Z';
