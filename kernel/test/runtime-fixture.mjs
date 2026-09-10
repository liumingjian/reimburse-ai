import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { inspectRuntimeDependencies } from '../src/runtime-dependencies.mjs';

/**
 * Seed only the observable managed-runtime contract. CLI tests that exercise
 * browser or state behavior should not depend on a developer's real uv cache.
 */
export function seedReadyRuntimes(home) {
  const checked = inspectRuntimeDependencies({
    home,
    uvCommand: process.execPath,
    commandExists: () => true,
  });
  const mark = checked.runtimes.markitdown;
  fs.mkdirSync(path.dirname(mark.pythonPath), { recursive: true });
  fs.writeFileSync(mark.pythonPath, '', { mode: 0o700 });
  fs.writeFileSync(mark.manifestPath, JSON.stringify({
    schemaVersion: 1,
    runtime: mark.id,
    version: mark.version,
    lockHash: mark.lockHash,
    source: mark.source,
    installDir: mark.installDir,
  }));

  const ocr = checked.runtimes['extract-reimbursement-images'];
  const requirementsHash = crypto.createHash('sha256')
    .update(fs.readFileSync(ocr.requirementsPath)).digest('hex');
  fs.mkdirSync(path.dirname(ocr.pythonPath), { recursive: true });
  fs.writeFileSync(ocr.pythonPath, '', { mode: 0o700 });
  fs.writeFileSync(ocr.manifestPath, JSON.stringify({
    schemaVersion: 1,
    runtime: ocr.id,
    runtimeVersion: ocr.version,
    engine: ocr.engine,
    engineVersion: ocr.engineVersion,
    model: ocr.model,
    onnxruntime: ocr.onnxruntime,
    source: ocr.source,
    installerHash: ocr.installerHash,
    requirementsHash,
    installDir: ocr.installDir,
  }));
  return { BAOX_HOME: home, BAOX_UV: process.execPath };
}
