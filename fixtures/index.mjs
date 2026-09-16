// @baox/fixtures: where the generated sample materials live and the manifest that names them. Node-only.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const GENERATED_DIR = fileURLToPath(new URL('./generated', import.meta.url));
export const SAMPLE_MATERIALS_FILE = fileURLToPath(new URL('./sample-materials.json', import.meta.url));
export const SAMPLE_MATERIALS = JSON.parse(readFileSync(SAMPLE_MATERIALS_FILE, 'utf8'));
// Regression fixtures: generated materials that exist only for tests, kept out of `sample-materials.json` so the
// mock's demo set (m01–m11) stays as it is.
export const REGRESSION_MATERIALS = [{ file: 'r201-bundled-fee-invoice.pdf', fileName: '网约车_发票_含服务费.pdf' }];

// A synthetic legacy `~/.baox` (schemaVersion 1) for the one-time import (#195). Read-only: tests copy it before
// changing anything.
export const LEGACY_BAOX_DIR = fileURLToPath(new URL('./legacy-baox', import.meta.url));
