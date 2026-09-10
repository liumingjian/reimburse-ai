import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MARKITDOWN_VERSION,
  OCR_ENGINE,
  OCR_ENGINE_VERSION,
  OCR_MODEL,
  OCR_ONNX_RUNTIME_VERSION,
  OCR_RUNTIME_ID,
  OCR_RUNTIME_VERSION,
  RuntimeDependencyError,
  inspectRuntimeDependencies,
  installRuntimeDependencies,
  runtimeDependencyStep,
} from '../src/runtime-dependencies.mjs';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'baox-runtime-dependencies-'));
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

function fixture(options = {}) {
  const home = options.home ?? tempDir();
  const pdfRuntimeDir = options.pdfRuntimeDir ?? path.join(home, 'skill', 'kernel', 'src', 'pdf-markdown-runtime');
  const markitdownInstallDir = options.markitdownInstallDir ?? path.join(home, 'runtimes', 'markitdown', 'v1');
  const ocrRuntimeDir = options.ocrRuntimeDir ?? path.join(home, 'ocr-runtime', 'v1');
  const ocrInstallerPath = options.ocrInstallerPath
    ?? path.join(home, 'skill', 'extract-reimbursement-images', 'runtime', 'install-runtime.mjs');
  const ocrRequirementsPath = options.ocrRequirementsPath
    ?? path.join(home, 'skill', 'extract-reimbursement-images', 'runtime', 'python', 'requirements-rapid.txt');
  fs.mkdirSync(pdfRuntimeDir, { recursive: true });
  fs.writeFileSync(path.join(pdfRuntimeDir, 'pyproject.toml'), [
    '[project]',
    'name = "baox-pdf-markdown-runtime"',
    `dependencies = ["markitdown[pdf]==${MARKITDOWN_VERSION}"]`,
  ].join('\n'));
  fs.writeFileSync(path.join(pdfRuntimeDir, 'uv.lock'), `name = "markitdown"\nversion = "${MARKITDOWN_VERSION}"\n`);
  fs.writeFileSync(path.join(pdfRuntimeDir, 'runner.py'), '# pinned runner\n');
  fs.mkdirSync(path.dirname(ocrInstallerPath), { recursive: true });
  fs.writeFileSync(ocrInstallerPath, '# managed OCR installer\n');
  fs.mkdirSync(path.dirname(ocrRequirementsPath), { recursive: true });
  fs.writeFileSync(ocrRequirementsPath, [
    `rapidocr==${OCR_ENGINE_VERSION}`,
    `onnxruntime==${OCR_ONNX_RUNTIME_VERSION}`,
  ].join('\n'));
  return { home, pdfRuntimeDir, markitdownInstallDir, ocrRuntimeDir, ocrInstallerPath, ocrRequirementsPath };
}

const optionsFor = (fixtureData, extra = {}) => ({
  ...fixtureData,
  uvCommand: 'uv-fixture',
  commandExists: () => true,
  ...extra,
});

test('setup cannot pass when parsing runtimes are absent, and emits the install step', () => {
  const home = tempDir();
  const pdfRuntimeDir = path.join(home, 'skill', 'kernel', 'src', 'pdf-markdown-runtime');
  fs.mkdirSync(pdfRuntimeDir, { recursive: true });
  fs.writeFileSync(path.join(pdfRuntimeDir, 'pyproject.toml'), [
    '[project]',
    'name = "baox-pdf-markdown-runtime"',
    'dependencies = ["markitdown[pdf]==0.1.7"]',
  ].join('\n'));
  fs.writeFileSync(path.join(pdfRuntimeDir, 'uv.lock'), 'markitdown==0.1.7\n');
  fs.writeFileSync(path.join(pdfRuntimeDir, 'runner.py'), '# pinned runner\n');

  const checked = inspectRuntimeDependencies({
    home,
    pdfRuntimeDir,
    ocrRuntimeDir: path.join(home, 'ocr-runtime', 'v1'),
    uvCommand: path.join(home, 'bin', 'uv'),
    ocrInstallerPath: path.join(home, 'skill', 'extract-reimbursement-images', 'runtime', 'install-runtime.mjs'),
    ocrRequirementsPath: path.join(home, 'skill', 'extract-reimbursement-images', 'runtime', 'python', 'requirements-rapid.txt'),
    commandExists: () => true,
  });

  assert.equal(checked.ready, false, 'setup must not pass and let parsing discover missing tools');
  assert.deepEqual(checked.missing, ['markitdown', 'extract-reimbursement-images']);
  assert.equal(checked.runtimes.markitdown.status, 'missing');
  assert.equal(checked.runtimes['extract-reimbursement-images'].status, 'missing');

  const step = runtimeDependencyStep({
    home,
    pdfRuntimeDir,
    ocrRuntimeDir: path.join(home, 'ocr-runtime', 'v1'),
    uvCommand: path.join(home, 'bin', 'uv'),
    ocrInstallerPath: path.join(home, 'skill', 'extract-reimbursement-images', 'runtime', 'install-runtime.mjs'),
    ocrRequirementsPath: path.join(home, 'skill', 'extract-reimbursement-images', 'runtime', 'python', 'requirements-rapid.txt'),
  });
  assert.equal(step.kind, 'run');
  assert.equal(step.outsourceable, true);
  assert.ok(step.argv.includes('runtime-setup'));
  assert.ok(step.argv.includes('--yes'));
  assert.equal(step.env.BAOX_HOME, home);
});

test('setup is ready only after both managed manifests and interpreters are present', () => {
  const data = fixture();
  const initial = inspectRuntimeDependencies(optionsFor(data));
  fs.mkdirSync(path.join(data.markitdownInstallDir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(data.markitdownInstallDir, 'bin', 'python'), '', { mode: 0o700 });
  fs.writeFileSync(path.join(data.markitdownInstallDir, 'runtime.json'), JSON.stringify({
    schemaVersion: 1,
    runtime: 'markitdown',
    version: MARKITDOWN_VERSION,
    lockHash: initial.runtimes.markitdown.lockHash,
  }));
  fs.mkdirSync(path.join(data.ocrRuntimeDir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(data.ocrRuntimeDir, 'bin', 'python'), '', { mode: 0o700 });
  fs.writeFileSync(path.join(data.ocrRuntimeDir, 'runtime.json'), JSON.stringify({
    schemaVersion: 1,
    runtime: OCR_RUNTIME_ID,
    runtimeVersion: OCR_RUNTIME_VERSION,
    engine: OCR_ENGINE,
    engineVersion: OCR_ENGINE_VERSION,
    model: OCR_MODEL,
    onnxruntime: OCR_ONNX_RUNTIME_VERSION,
    source: 'PyPI packages pinned by the bundled extract-reimbursement-images installer',
    installerHash: hash(fs.readFileSync(data.ocrInstallerPath)),
    requirementsHash: hash(fs.readFileSync(data.ocrRequirementsPath)),
  }));

  const checked = inspectRuntimeDependencies(optionsFor(data));
  assert.equal(checked.ready, true);
  assert.deepEqual(checked.missing, []);
});

test('installation syncs MarkItDown before health checks and keeps OCR under BAOX_HOME', () => {
  const data = fixture();
  const calls = [];
  const spawnSyncImpl = (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'uv-fixture' && args[0] === 'sync') {
      fs.mkdirSync(path.join(data.markitdownInstallDir, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(data.markitdownInstallDir, 'bin', 'python'), '', { mode: 0o700 });
    }
    if (command === process.execPath && args[0] === data.ocrInstallerPath) {
      fs.mkdirSync(path.join(data.ocrRuntimeDir, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(data.ocrRuntimeDir, 'bin', 'python'), '', { mode: 0o700 });
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  const result = installRuntimeDependencies(optionsFor(data, { spawnSyncImpl }));
  assert.equal(result.status, 'installed');
  assert.equal(result.ready, true);
  const sync = calls.find((call) => call.command === 'uv-fixture' && call.args[0] === 'sync');
  assert.deepEqual(sync.args, ['sync', '--project', data.pdfRuntimeDir, '--locked']);
  assert.equal(sync.options.env.BAOX_HOME, data.home);
  assert.equal(sync.options.env.UV_PROJECT_ENVIRONMENT, data.markitdownInstallDir);
  assert.ok(!calls.some((call) => call.command === 'python3' || call.command === 'python3.11'),
    'the installer must not fall back to a global Python interpreter');
  assert.equal(fs.existsSync(path.join(data.home, 'runtime-dependencies.json')), false,
    'runtime setup writes its structured result through the kernel command, not into the data root as a side effect');
});

test('installation reports the locked runtime failure and does not continue to OCR', () => {
  const data = fixture();
  const calls = [];
  const spawnSyncImpl = (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'uv-fixture' && args[0] === 'sync') {
      return { status: 1, stdout: '', stderr: 'network is unavailable' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };

  assert.throws(
    () => installRuntimeDependencies(optionsFor(data, { spawnSyncImpl })),
    (error) => error instanceof RuntimeDependencyError
      && error.code === 'MARKITDOWN_INSTALL_FAILED'
      && error.message === 'network is unavailable',
  );
  assert.equal(calls.filter((call) => call.command === process.execPath
    && call.args[0] === data.ocrInstallerPath).length, 0,
  'OCR must not run after the locked MarkItDown setup failed');
});
