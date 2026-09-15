// @baox/fixtures: where the generated sample materials live and the manifest that names them. Node-only.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const GENERATED_DIR = fileURLToPath(new URL('./generated', import.meta.url));
export const SAMPLE_MATERIALS_FILE = fileURLToPath(new URL('./sample-materials.json', import.meta.url));
export const SAMPLE_MATERIALS = JSON.parse(readFileSync(SAMPLE_MATERIALS_FILE, 'utf8'));
