import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  MARKITDOWN_VERSION,
  PDF_MARKDOWN_RUNTIME_DIR,
} from './pdf-markdown.mjs';

const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
const KERNEL_BIN = path.join(path.dirname(SOURCE_DIR), 'bin', 'baox.mjs');
const DEFAULT_HOME = path.join(os.homedir(), '.baox');
const RUNTIME_SCHEMA_VERSION = 1;

export const MARKITDOWN_RUNTIME_ID = 'markitdown';
export { MARKITDOWN_VERSION };
export const OCR_RUNTIME_ID = 'extract-reimbursement-images';
export const OCR_RUNTIME_VERSION = 'v1';
export const OCR_ENGINE = 'rapidocr';
export const OCR_ENGINE_VERSION = '3.9.2';
export const OCR_MODEL = 'PP-OCRv6-small';
export const OCR_ONNX_RUNTIME_VERSION = '1.23.2';
export const RUNTIME_MANIFEST_VERSION = RUNTIME_SCHEMA_VERSION;

export class RuntimeDependencyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RuntimeDependencyError';
    this.code = code;
    this.details = details;
  }
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const fileHash = (filePath) => sha256(fs.readFileSync(filePath));
const isFile = (filePath) => {
  try { return fs.statSync(filePath).isFile(); } catch { return false; }
};
const isDirectory = (filePath) => {
  try { return fs.statSync(filePath).isDirectory(); } catch { return false; }
};
const readText = (filePath) => {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return null; }
};
const executableName = (name) => process.platform === 'win32' ? `${name}.exe` : name;

export function runtimeHome(home = process.env.BAOX_HOME ?? DEFAULT_HOME) {
  return path.resolve(home);
}

export function defaultMarkItDownInstallDir(home = process.env.BAOX_HOME ?? DEFAULT_HOME) {
  return path.join(runtimeHome(home), 'runtimes', MARKITDOWN_RUNTIME_ID, 'v1');
}

export function defaultOcrRuntimeDir(home = process.env.BAOX_HOME ?? DEFAULT_HOME) {
  return path.join(runtimeHome(home), 'ocr-runtime', OCR_RUNTIME_VERSION);
}

export function defaultOcrInstallerPath() {
  return ocrSourceLayouts().find((layout) => isFile(layout.installer))?.installer
    ?? ocrSourceLayouts()[0].installer;
}

export function defaultOcrRequirementsPath() {
  return ocrSourceLayouts().find((layout) => isFile(layout.requirements))?.requirements
    ?? ocrSourceLayouts()[0].requirements;
}

function ocrSourceLayouts() {
  const skillRoot = path.resolve(SOURCE_DIR, '../..');
  const skillsRoot = path.dirname(skillRoot);
  const packageRoot = path.resolve(SOURCE_DIR, '../../packages/image-field-extraction');
  const siblingSkillRoots = [
    skillRoot,
    ...['baox', 'baox-setup', 'baox-recover', 'extract-reimbursement-images']
      .map((name) => path.join(skillsRoot, name)),
  ];
  return [
    {
      installer: path.join(packageRoot, 'scripts', 'install-runtime.mjs'),
      requirements: path.join(packageRoot, 'python', 'requirements-rapid.txt'),
    },
    ...siblingSkillRoots.map((root) => ({
      installer: path.join(root, 'runtime', 'install-runtime.mjs'),
      requirements: path.join(root, 'runtime', 'python', 'requirements-rapid.txt'),
    })),
  ];
}

function defaultSpawnSync(command, args, options) {
  return nodeSpawnSync(command, args, options);
}

function commandExists(command, spawnSyncImpl = defaultSpawnSync) {
  const result = spawnSyncImpl(command, ['--version'], { stdio: 'ignore' });
  return result?.status === 0;
}

function runtimePython(runtimeDir) {
  return path.join(runtimeDir, process.platform === 'win32' ? 'Scripts' : 'bin', executableName('python'));
}

function manifestPath(runtimeDir) {
  return path.join(runtimeDir, 'runtime.json');
}

function readJson(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function markItDownSource({ pdfRuntimeDir, lockPath = path.join(pdfRuntimeDir, 'uv.lock'), runnerPath = path.join(pdfRuntimeDir, 'runner.py') }) {
  const pyprojectPath = path.join(pdfRuntimeDir, 'pyproject.toml');
  const pyproject = readText(pyprojectPath);
  const lock = readText(lockPath);
  const errors = [];
  if (!isDirectory(pdfRuntimeDir)) errors.push('MarkItDown runtime directory is missing');
  if (!pyproject) errors.push('MarkItDown pyproject.toml is missing');
  if (!lock) errors.push('MarkItDown uv.lock is missing');
  if (!isFile(runnerPath)) errors.push('MarkItDown runner.py is missing');
  if (pyproject && !pyproject.includes(`markitdown[pdf]==${MARKITDOWN_VERSION}`)) {
    errors.push(`MarkItDown pyproject is not pinned to ${MARKITDOWN_VERSION}`);
  }
  if (lock && (!lock.includes('name = "markitdown"') || !lock.includes(`version = "${MARKITDOWN_VERSION}"`))) {
    errors.push(`MarkItDown uv.lock is not pinned to ${MARKITDOWN_VERSION}`);
  }
  return {
    ok: errors.length === 0,
    errors,
    pyprojectPath,
    lockPath,
    runnerPath,
    lockHash: lock ? sha256(lock) : null,
  };
}

function markItDownRuntime({ home, pdfRuntimeDir, markitdownInstallDir, uvCommand, commandExists: hasCommand, spawnSyncImpl }) {
  const source = markItDownSource({ pdfRuntimeDir });
  const pythonPath = runtimePython(markitdownInstallDir);
  const manifestFile = manifestPath(markitdownInstallDir);
  const manifest = readJson(manifestFile);
  const reasons = [...source.errors];
  if (!hasCommand(uvCommand, spawnSyncImpl)) reasons.push(`uv command is unavailable: ${uvCommand}`);
  if (!isDirectory(markitdownInstallDir) || !isFile(pythonPath)) reasons.push('managed MarkItDown Python environment is missing');
  if (!manifest) reasons.push('managed MarkItDown runtime manifest is missing or invalid');
  if (manifest) {
    if (manifest.schemaVersion !== RUNTIME_MANIFEST_VERSION) reasons.push('managed MarkItDown manifest version is unsupported');
    if (manifest.runtime !== MARKITDOWN_RUNTIME_ID) reasons.push('managed MarkItDown manifest identifies another runtime');
    if (manifest.version !== MARKITDOWN_VERSION) reasons.push(`managed MarkItDown manifest is not pinned to ${MARKITDOWN_VERSION}`);
    if (manifest.lockHash !== source.lockHash) reasons.push('managed MarkItDown manifest does not match the bundled uv.lock');
  }
  const status = reasons.length === 0 ? 'ready' : (source.ok && isDirectory(markitdownInstallDir) ? 'invalid' : 'missing');
  return {
    id: MARKITDOWN_RUNTIME_ID,
    status,
    ready: status === 'ready',
    version: MARKITDOWN_VERSION,
    source: 'bundled pyproject.toml + uv.lock (PyPI hashes in uv.lock)',
    sourceDir: path.resolve(pdfRuntimeDir),
    installDir: path.resolve(markitdownInstallDir),
    lockPath: path.resolve(source.lockPath),
    lockHash: source.lockHash,
    manifestPath: path.resolve(manifestFile),
    pythonPath: path.resolve(pythonPath),
    reasons,
    home: path.resolve(home),
  };
}

function expectedOcrManifest(installerPath, requirementsPath) {
  return {
    schemaVersion: RUNTIME_MANIFEST_VERSION,
    runtime: OCR_RUNTIME_ID,
    runtimeVersion: OCR_RUNTIME_VERSION,
    engine: OCR_ENGINE,
    engineVersion: OCR_ENGINE_VERSION,
    model: OCR_MODEL,
    onnxruntime: OCR_ONNX_RUNTIME_VERSION,
    source: 'PyPI packages pinned by the bundled extract-reimbursement-images installer',
    installerHash: isFile(installerPath) ? fileHash(installerPath) : null,
    requirementsHash: isFile(requirementsPath) ? fileHash(requirementsPath) : null,
  };
}

function pinnedRequirementsErrors(requirementsPath) {
  const requirements = readText(requirementsPath);
  if (requirements === null) return ['OCR requirements-rapid.txt is missing'];
  const lines = new Set(requirements.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  return [`rapidocr==${OCR_ENGINE_VERSION}`, `onnxruntime==${OCR_ONNX_RUNTIME_VERSION}`]
    .filter((pinned) => !lines.has(pinned))
    .map((pinned) => `OCR requirements-rapid.txt is not pinned to ${pinned}`);
}

function ocrRuntime({ home, ocrRuntimeDir, ocrInstallerPath, ocrRequirementsPath }) {
  const pythonPath = runtimePython(ocrRuntimeDir);
  const manifestFile = manifestPath(ocrRuntimeDir);
  const manifest = readJson(manifestFile);
  const expected = expectedOcrManifest(ocrInstallerPath, ocrRequirementsPath);
  const reasons = pinnedRequirementsErrors(ocrRequirementsPath);
  if (!isDirectory(ocrRuntimeDir) || !isFile(pythonPath)) reasons.push('managed OCR Python environment is missing');
  if (!isFile(ocrInstallerPath)) reasons.push('extract-reimbursement-images installer is missing');
  if (!manifest) reasons.push('managed OCR runtime manifest is missing or invalid');
  if (manifest) {
    for (const [key, value] of Object.entries(expected)) {
      if (value !== null && manifest[key] !== value) reasons.push(`managed OCR manifest ${key} is not pinned to ${value}`);
    }
  }
  const status = reasons.length === 0 ? 'ready' : (isDirectory(ocrRuntimeDir) ? 'invalid' : 'missing');
  return {
    id: OCR_RUNTIME_ID,
    status,
    ready: status === 'ready',
    version: OCR_RUNTIME_VERSION,
    engine: OCR_ENGINE,
    engineVersion: OCR_ENGINE_VERSION,
    model: OCR_MODEL,
    onnxruntime: OCR_ONNX_RUNTIME_VERSION,
    source: expected.source,
    installDir: path.resolve(ocrRuntimeDir),
    manifestPath: path.resolve(manifestFile),
    installerPath: path.resolve(ocrInstallerPath),
    requirementsPath: path.resolve(ocrRequirementsPath),
    pythonPath: path.resolve(pythonPath),
    installerHash: expected.installerHash,
    reasons,
    home: path.resolve(home),
  };
}

function resolvedOptions(options = {}) {
  const home = runtimeHome(options.home);
  const pdfRuntimeDir = path.resolve(options.pdfRuntimeDir ?? PDF_MARKDOWN_RUNTIME_DIR);
  const markitdownInstallDir = path.resolve(options.markitdownInstallDir ?? defaultMarkItDownInstallDir(home));
  const ocrRuntimeDir = path.resolve(options.ocrRuntimeDir ?? defaultOcrRuntimeDir(home));
  const ocrInstallerPath = path.resolve(options.ocrInstallerPath ?? process.env.BAOX_OCR_INSTALLER ?? defaultOcrInstallerPath());
  const ocrRequirementsPath = path.resolve(options.ocrRequirementsPath
    ?? process.env.BAOX_OCR_REQUIREMENTS ?? defaultOcrRequirementsPath());
  const uvCommand = options.uvCommand ?? process.env.BAOX_UV ?? 'uv';
  const spawnSyncImpl = options.spawnSyncImpl ?? defaultSpawnSync;
  const hasCommand = options.commandExists ?? commandExists;
  return {
    ...options,
    home,
    pdfRuntimeDir,
    markitdownInstallDir,
    ocrRuntimeDir,
    ocrInstallerPath,
    ocrRequirementsPath,
    uvCommand,
    spawnSyncImpl,
    commandExists: hasCommand,
  };
}

export function inspectRuntimeDependencies(options = {}) {
  const resolved = resolvedOptions(options);
  const runtimes = {
    [MARKITDOWN_RUNTIME_ID]: markItDownRuntime(resolved),
    [OCR_RUNTIME_ID]: ocrRuntime(resolved),
  };
  const missing = Object.values(runtimes).filter((runtime) => !runtime.ready).map((runtime) => runtime.id);
  return {
    schemaVersion: RUNTIME_MANIFEST_VERSION,
    ready: missing.length === 0,
    status: missing.length === 0 ? 'ready' : 'blocked',
    runtimes,
    missing,
    home: resolved.home,
    install: runtimeDependencyStep(resolved),
  };
}

export const checkRuntimeDependencies = inspectRuntimeDependencies;

export function runtimeDependencyStep(options = {}) {
  const resolved = resolvedOptions(options);
  return {
    kind: 'run',
    argv: [
      process.execPath,
      KERNEL_BIN,
      'runtime-setup',
      '--yes',
      '--pdf-runtime', resolved.pdfRuntimeDir,
      '--markitdown-install', resolved.markitdownInstallDir,
      '--ocr-runtime', resolved.ocrRuntimeDir,
      '--ocr-installer', resolved.ocrInstallerPath,
      '--ocr-requirements', resolved.ocrRequirementsPath,
    ],
    outsourceable: true,
    env: { BAOX_HOME: resolved.home, BAOX_UV: resolved.uvCommand },
    out: path.join(resolved.home, 'runtime-dependencies.json'),
    runtimes: [MARKITDOWN_RUNTIME_ID, OCR_RUNTIME_ID],
  };
}

export const runtimeSetupStep = runtimeDependencyStep;

function command(command, args, { cwd, env, spawnSyncImpl }) {
  const result = spawnSyncImpl(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    ok: result?.status === 0,
    status: result?.status ?? null,
    stdout: String(result?.stdout ?? ''),
    stderr: String(result?.stderr ?? ''),
    error: result?.error ?? null,
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function markitdownManifest(source, installDir) {
  return {
    schemaVersion: RUNTIME_MANIFEST_VERSION,
    runtime: MARKITDOWN_RUNTIME_ID,
    version: MARKITDOWN_VERSION,
    lockHash: source.lockHash,
    source: 'bundled pyproject.toml + uv.lock (PyPI hashes in uv.lock)',
    installDir: path.resolve(installDir),
  };
}

function ocrManifest(installerPath, requirementsPath, installDir) {
  return { ...expectedOcrManifest(installerPath, requirementsPath), installDir: path.resolve(installDir) };
}

export function installRuntimeDependencies(options = {}) {
  const resolved = resolvedOptions(options);
  const source = markItDownSource({ pdfRuntimeDir: resolved.pdfRuntimeDir });
  if (!source.ok) {
    throw new RuntimeDependencyError('MARKITDOWN_SOURCE_INVALID', source.errors.join('; '), { source });
  }
  if (!resolved.commandExists(resolved.uvCommand, resolved.spawnSyncImpl)) {
    throw new RuntimeDependencyError('UV_UNAVAILABLE', `uv command is unavailable: ${resolved.uvCommand}`);
  }
  fs.mkdirSync(resolved.markitdownInstallDir, { recursive: true, mode: 0o700 });
  const env = {
    ...process.env,
    ...resolved.env,
    BAOX_HOME: resolved.home,
    UV_PROJECT_ENVIRONMENT: resolved.markitdownInstallDir,
  };
  const sync = command(resolved.uvCommand,
    ['sync', '--project', resolved.pdfRuntimeDir, '--locked'],
    { cwd: resolved.pdfRuntimeDir, env, spawnSyncImpl: resolved.spawnSyncImpl });
  if (!sync.ok) {
    throw new RuntimeDependencyError('MARKITDOWN_INSTALL_FAILED',
      sync.stderr.trim() || sync.error?.message || `uv sync exited with ${sync.status}`, { sync });
  }
  const health = command(resolved.uvCommand,
    ['run', '--project', resolved.pdfRuntimeDir, '--locked', 'python', '-c',
      'from markitdown import MarkItDown; MarkItDown(enable_plugins=False)'],
    { cwd: resolved.pdfRuntimeDir, env, spawnSyncImpl: resolved.spawnSyncImpl });
  if (!health.ok) {
    throw new RuntimeDependencyError('MARKITDOWN_HEALTH_FAILED',
      health.stderr.trim() || health.error?.message || `MarkItDown health check exited with ${health.status}`, { health });
  }
  writeJson(manifestPath(resolved.markitdownInstallDir), markitdownManifest(source, resolved.markitdownInstallDir));

  if (!isFile(resolved.ocrInstallerPath)) {
    throw new RuntimeDependencyError('OCR_INSTALLER_MISSING',
      `extract-reimbursement-images installer is missing: ${resolved.ocrInstallerPath}`);
  }
  const requirementsErrors = pinnedRequirementsErrors(resolved.ocrRequirementsPath);
  if (requirementsErrors.length) {
    throw new RuntimeDependencyError('OCR_REQUIREMENTS_NOT_PINNED', requirementsErrors.join('; '));
  }
  const ocr = command(process.execPath, [resolved.ocrInstallerPath, '--yes'], {
    cwd: path.dirname(resolved.ocrInstallerPath),
    env: { ...process.env, ...resolved.env, BAOX_HOME: resolved.home },
    spawnSyncImpl: resolved.spawnSyncImpl,
  });
  if (!ocr.ok) {
    throw new RuntimeDependencyError('OCR_INSTALL_FAILED',
      ocr.stderr.trim() || ocr.error?.message || `OCR installer exited with ${ocr.status}`, { ocr });
  }
  if (!isFile(runtimePython(resolved.ocrRuntimeDir))) {
    throw new RuntimeDependencyError('OCR_HEALTH_FAILED',
      `OCR installer completed but managed Python is missing: ${runtimePython(resolved.ocrRuntimeDir)}`);
  }
  writeJson(manifestPath(resolved.ocrRuntimeDir), ocrManifest(
    resolved.ocrInstallerPath, resolved.ocrRequirementsPath, resolved.ocrRuntimeDir));

  const checked = inspectRuntimeDependencies(resolved);
  if (!checked.ready) {
    throw new RuntimeDependencyError('RUNTIME_VERIFY_FAILED',
      checked.missing.map((id) => `${id}: ${checked.runtimes[id].reasons.join('; ')}`).join('\n'), { checked });
  }
  return { ...checked, status: 'installed' };
}

export const install = installRuntimeDependencies;
