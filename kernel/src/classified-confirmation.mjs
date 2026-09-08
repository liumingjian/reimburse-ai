import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { taskDir } from './workspace.mjs';

const RECORD_VERSION = 1;
const OWNER_FILE = '.baox-owner.json';
const MANIFEST_FILE = 'manifest.json';
const RECORD_FILE = 'classified-detail-confirmation.json';
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const writePrivateJson = (file, value) => {
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);
};
const fileHash = (file) => sha256(fs.readFileSync(file));
const manifestDigest = (manifest) => sha256(JSON.stringify(manifest));
const inside = (root, candidate) => candidate.startsWith(`${root}${path.sep}`);
const safeUploadRoot = (task, { create = false } = {}) => {
  const workspace = taskDir(task);
  const workspaceStat = fs.lstatSync(workspace, { throwIfNoEntry: false });
  if (!workspaceStat?.isDirectory() || workspaceStat.isSymbolicLink()) return null;
  const realWorkspace = fs.realpathSync(workspace);
  const uploadRoot = path.join(workspace, 'erp-upload');
  const uploadStat = fs.lstatSync(uploadRoot, { throwIfNoEntry: false });
  if (!uploadStat && create) fs.mkdirSync(uploadRoot, { mode: 0o700 });
  const current = fs.lstatSync(uploadRoot, { throwIfNoEntry: false });
  if (!current?.isDirectory() || current.isSymbolicLink()) return null;
  return inside(realWorkspace, fs.realpathSync(uploadRoot)) ? uploadRoot : null;
};

export function classifiedDetailAggregate({ inventory, classification, events, lines }) {
  const materials = new Map(inventory.materials.map((m) => [m.materialId, m]));
  const results = new Map(classification.results.map((r) => [r.materialId, r]));
  const eventById = new Map(events.events.map((e) => [e.eventId, e]));
  const rows = [...lines].sort((a, b) => a.lineId.localeCompare(b.lineId)).map((line) => {
    const voucher = results.get(line.voucherMaterialId);
    const material = materials.get(line.voucherMaterialId);
    const event = eventById.get(line.eventId);
    if (!voucher || voucher.role !== 'primary_voucher' || !material || !event) {
      throw new Error(`明细 ${line.lineId} 没有唯一的主要报销凭证`);
    }
    return {
      lineRef: line.lineId,
      materialRef: line.voucherMaterialId,
      voucher: voucher.maskedNumber ?? '（无票号）',
      date: line.date ?? null,
      amount: line.totalAmount ?? null,
      amountSource: line.amountSource ?? null,
      city: line.city ?? null,
      route: line.route ?? null,
      category: line.category ?? null,
      categoryLabel: line.categoryLabel ?? null,
      association: {
        primary: line.voucherMaterialId,
        references: [...(event.referenceMaterialIds ?? line.referenceMaterialIds ?? [])].sort(),
      },
    };
  });
  if (new Set(rows.map((r) => r.lineRef)).size !== rows.length) throw new Error('明细引用不唯一');
  const readingBasis = classification.results.map((r) => ({
    materialId: r.materialId, contentHash: r.contentHash ?? null, role: r.role ?? null,
    kind: r.kind ?? null, fields: r.fields ?? {}, fieldSources: r.fieldSources ?? {},
    candidates: r.candidates ?? [], evidence: r.evidence ?? {}, segments: r.segments ?? [],
  })).sort((a, b) => a.materialId.localeCompare(b.materialId));
  return { version: RECORD_VERSION, inventoryVersion: inventory.versionId,
    readingBasisDigest: sha256(JSON.stringify(readingBasis)), rows };
}

export const classifiedDetailDigest = (aggregate) => sha256(JSON.stringify(aggregate));
export const loadClassifiedDetailConfirmation = (task, digest) =>
  readJson(path.join(taskDir(task), 'erp-upload', digest, RECORD_FILE));

export function confirmationStatus(task, aggregate) {
  const digest = classifiedDetailDigest(aggregate);
  const uploadRoot = safeUploadRoot(task);
  if (!uploadRoot) return { confirmed: false, staged: false, digest, record: null };
  const dir = path.join(uploadRoot, digest);
  const record = readJson(path.join(dir, RECORD_FILE));
  if (!record || record.version !== RECORD_VERSION || record.digest !== digest) {
    return { confirmed: false, staged: false, digest, record };
  }
  const owner = readJson(path.join(dir, OWNER_FILE));
  const manifest = readJson(path.join(dir, MANIFEST_FILE));
  const dirStat = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!dirStat?.isDirectory() || dirStat.isSymbolicLink() || (dirStat.mode & 0o777) !== 0o700
    || owner?.taskId !== task.taskId || owner?.digest !== digest
    || manifest?.version !== RECORD_VERSION || manifest?.digest !== digest
    || !Array.isArray(manifest?.files) || record.manifestDigest !== manifestDigest(manifest)) {
    return { confirmed: true, staged: false, digest, record };
  }
  const metadataFiles = [OWNER_FILE, MANIFEST_FILE, RECORD_FILE].map((name) => fs.lstatSync(path.join(dir, name),
    { throwIfNoEntry: false }));
  if (metadataFiles.some((st) => !st?.isFile() || st.isSymbolicLink() || (st.mode & 0o777) !== 0o600)
    || manifest.files.some((f) => path.basename(f.stagedName) !== f.stagedName)) {
    return { confirmed: true, staged: false, digest, record };
  }
  const expected = new Set([OWNER_FILE, MANIFEST_FILE, RECORD_FILE,
    ...manifest.files.map((f) => f.stagedName)]);
  const names = fs.readdirSync(dir);
  if (names.length !== expected.size || names.some((name) => !expected.has(name))) {
    return { confirmed: true, staged: false, digest, record };
  }
  const valid = manifest.files.every((entry) => {
    const file = path.join(dir, entry.stagedName);
    const st = fs.lstatSync(file, { throwIfNoEntry: false });
    return st?.isFile() && !st.isSymbolicLink() && (st.mode & 0o777) === 0o600
      && fileHash(file) === entry.sourceHash;
  });
  return { confirmed: true, staged: valid, digest, record, manifest: valid ? manifest : null };
}

export function confirmAndStage({ sourceDir, task, inventory, classification, aggregate, digest }) {
  if (classifiedDetailDigest(aggregate) !== digest) return null;
  const root = path.resolve(sourceDir);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('源目录不能是符号链接');
  const realRoot = fs.realpathSync(root);
  const byId = new Map(inventory.materials.map((m) => [m.materialId, m]));
  const primaryIds = [...new Set(aggregate.rows.map((r) => r.materialRef))].sort();
  const classifiedPrimary = new Set(classification.results
    .filter((r) => r.role === 'primary_voucher').map((r) => r.materialId));
  const uploadRoot = safeUploadRoot(task, { create: true });
  if (!uploadRoot) throw new Error('ERP 暂存根目录不是任务内安全目录');
  fs.chmodSync(uploadRoot, 0o700);
  const finalDir = path.join(uploadRoot, digest);
  const existing = confirmationStatus(task, aggregate);
  if (existing.confirmed && existing.staged) return existing.record;
  if (fs.existsSync(finalDir)) throw new Error('已有不可复核的暂存目录，拒绝覆盖');
  const tempDir = path.join(uploadRoot, `.${digest}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  fs.mkdirSync(tempDir, { mode: 0o700 });
  try {
    writePrivateJson(path.join(tempDir, OWNER_FILE), {
      version: RECORD_VERSION, taskId: task.taskId, digest,
    });
    const files = [];
    for (const materialId of primaryIds) {
      if (!classifiedPrimary.has(materialId)) throw new Error(`材料 ${materialId} 不是主要报销凭证`);
      const material = byId.get(materialId);
      if (!material?.relPath || !material.contentHash) throw new Error(`材料 ${materialId} 不完整`);
      const source = path.resolve(root, material.relPath);
      if (!inside(root, source)) throw new Error(`材料 ${materialId} 越出源目录`);
      const st = fs.lstatSync(source);
      if (!st.isFile() || st.isSymbolicLink()) throw new Error(`材料 ${materialId} 不是普通文件`);
      if (!inside(realRoot, fs.realpathSync(source))) throw new Error(`材料 ${materialId} 经符号链接越界`);
      if (fileHash(source) !== material.contentHash) throw new Error(`材料 ${materialId} 已变更`);
      const ext = path.extname(material.fileName).toLowerCase().replace(/[^.a-z0-9]/g, '');
      const stagedName = `${materialId}-${material.contentHash}${ext}`;
      const staged = path.join(tempDir, stagedName);
      fs.copyFileSync(source, staged, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(staged, 0o600);
      if (fileHash(staged) !== material.contentHash) throw new Error(`材料 ${materialId} 复制校验失败`);
      files.push({ materialId, sourceRelativePath: material.relPath, sourceHash: material.contentHash,
        stagedName, version: inventory.versionId });
    }
    const manifest = { version: RECORD_VERSION, digest, taskId: task.taskId,
      inventoryVersion: inventory.versionId, files };
    writePrivateJson(path.join(tempDir, MANIFEST_FILE), manifest);
    const record = { version: RECORD_VERSION, digest, manifestDigest: manifestDigest(manifest),
      inventoryVersion: inventory.versionId, confirmedAt: new Date().toISOString(),
      stagingDirectory: `erp-upload/${digest}` };
    writePrivateJson(path.join(tempDir, RECORD_FILE), record);
    fs.chmodSync(path.join(tempDir, OWNER_FILE), 0o600);
    fs.chmodSync(path.join(tempDir, MANIFEST_FILE), 0o600);
    fs.chmodSync(path.join(tempDir, RECORD_FILE), 0o600);
    fs.renameSync(tempDir, finalDir);
    return record;
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

export function cleanupOwnedStaging(task) {
  const root = safeUploadRoot(task);
  if (!root) return { removed: 0 };
  let removed = 0;
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    const st = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (!st?.isDirectory() || st.isSymbolicLink()) continue;
    const owner = readJson(path.join(dir, OWNER_FILE));
    const finalized = owner?.digest === name;
    const temporary = typeof owner?.digest === 'string'
      && name.startsWith(`.${owner.digest}.`) && name.endsWith('.tmp');
    if (owner?.version !== RECORD_VERSION || owner?.taskId !== task.taskId
      || (!finalized && !temporary)) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    removed += 1;
  }
  return { removed };
}
