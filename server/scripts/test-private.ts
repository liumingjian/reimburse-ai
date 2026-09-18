import { runPrivateGate } from '../src/quality/private-gate';

// `pnpm test:private`: per-layout, per-field parser accuracy on the private corpus, failing below the thresholds in
// `src/quality/private-gate.ts`. Skips (exit 0) when BAOX_PRIVATE_CORPUS is unset. Aggregate output only.
process.exit(await runPrivateGate(process.env['BAOX_PRIVATE_CORPUS']));
