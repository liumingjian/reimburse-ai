// @baox/fixtures: where the generated sample materials live and the manifest that names them. Node-only.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const GENERATED_DIR = fileURLToPath(new URL('./generated', import.meta.url));
export const SAMPLE_MATERIALS_FILE = fileURLToPath(new URL('./sample-materials.json', import.meta.url));
export const SAMPLE_MATERIALS = JSON.parse(readFileSync(SAMPLE_MATERIALS_FILE, 'utf8'));
// 回归夹具（#200 起）：复现真实 PDF 的文本串拆分，只给测试用，不属于示例材料剧本。
export const REGRESSION_MATERIALS_FILE = fileURLToPath(new URL('./regression-materials.json', import.meta.url));
export const REGRESSION_MATERIALS = JSON.parse(readFileSync(REGRESSION_MATERIALS_FILE, 'utf8'));
// A synthetic legacy `~/.baox` (schemaVersion 1) for the one-time import (#195). Read-only: tests copy it before
// changing anything.
export const LEGACY_BAOX_DIR = fileURLToPath(new URL('./legacy-baox', import.meta.url));
