import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeMaterialScope } from './material-scope.mjs';

// v1 只接受 PDF、PNG、JPG，且按文件内容识别，扩展名只作提示（契约「原文件格式」）。
const MAGIC = [
  { format: 'pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  { format: 'png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { format: 'jpg', bytes: [0xff, 0xd8, 0xff] },
];
// 明确点名的不支持格式，给出比"无法识别"更有用的说明。
const KNOWN_UNSUPPORTED = [
  { format: 'zip-like', bytes: [0x50, 0x4b, 0x03, 0x04], note: 'ZIP 容器（OFD、压缩包、xlsx 都是这个开头）；v1 不支持' },
  { format: 'zip-empty', bytes: [0x50, 0x4b, 0x05, 0x06], note: '空 ZIP 容器；v1 不支持' },
];
export const SUPPORTED = new Set(['pdf', 'png', 'jpg']);

// 操作系统生成的垃圾文件。它们不是用户材料，但也不静默丢弃：
// 单独记进 ignored 并在摘要里报数，永远可追溯。
const SYSTEM_FILES = [/^\.DS_Store$/, /^\._/, /^Thumbs\.db$/i, /^desktop\.ini$/i];
const SKIP_DIRS = new Set(['.git', '.svn', '__MACOSX', 'node_modules']);

function detectFormat(head) {
  const match = (spec) => spec.bytes.every((b, i) => head[i] === b);
  for (const m of MAGIC) if (match(m)) return { format: m.format, supported: true };
  for (const m of KNOWN_UNSUPPORTED) if (match(m)) return { format: m.format, supported: false, note: m.note };
  return { format: 'unknown', supported: false, note: '文件内容不是 PDF/PNG/JPG，也不是已知的容器格式' };
}

// 材料标识按相对路径派生，因此在多个盘点版本之间稳定：
// 同一个位置上内容变了还是同一份材料（内容哈希会变），改名则视为删旧增新。
const materialId = (relPath) =>
  'm-' + crypto.createHash('sha256').update(relPath, 'utf8').digest('hex').slice(0, 12);

async function hashFile(abs) {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(abs)) h.update(chunk);
  return h.digest('hex');
}

async function* walk(root, rel = '') {
  const entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
  // 稳定顺序：同一个目录永远盘出同一个版本。
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(root, childRel);
    } else {
      yield { rel: childRel, dirent: e };
    }
  }
}

/**
 * 固定一次材料盘点。只读源目录：不移动、不改名、不覆盖、不删除。
 */
export async function takeInventory(sourceDir, { scope = null } = {}) {
  const root = path.resolve(sourceDir);
  const st = await fsp.stat(root).catch(() => null);
  if (!st?.isDirectory()) {
    const e = new Error(`不是一个目录：${sourceDir}`);
    e.code = 'SOURCE_NOT_A_DIR';
    throw e;
  }

  const materials = [];
  const ignored = [];
  const excluded = [];
  const scopeMismatches = [];
  const normalizedScope = normalizeMaterialScope(scope);
  const scopeByPath = new Map(normalizedScope?.exclusions.map((item) => [item.relPath, item]) ?? []);
  const scopeObserved = new Set();
  const addMaterial = (material) => {
    const expected = scopeByPath.get(material.relPath);
    if (!expected) {
      materials.push(material);
      return;
    }
    scopeObserved.add(material.relPath);
    if (material.readStatus === 'ok' && material.contentHash === expected.contentHash
      && material.size === expected.size) {
      excluded.push({ ...material, disposition: 'excluded', reason: 'explicit_scope',
        scopeReason: expected.reason });
      return;
    }
    scopeMismatches.push({ relPath: material.relPath, status: 'changed', expected,
      actual: { contentHash: material.contentHash ?? null, size: material.size ?? null,
        readStatus: material.readStatus ?? null } });
    materials.push(material);
  };

  for await (const { rel, dirent } of walk(root)) {
    const base = path.basename(rel);
    if (SYSTEM_FILES.some((re) => re.test(base))) {
      ignored.push({ relPath: rel, reason: 'system_file', note: '操作系统生成的文件，不是用户材料' });
      continue;
    }
    const rec = {
      materialId: materialId(rel),
      relPath: rel,
      fileName: base,
      extHint: path.extname(rel).toLowerCase() || null,
    };

    // 符号链接不跟随：跟随会越出材料根目录，契约要求不越界。
    if (dirent.isSymbolicLink()) {
      addMaterial({ ...rec, readStatus: 'skipped', disposition: 'out_of_scope',
        reason: 'symlink', note: '符号链接不跟随，避免越出材料根目录' });
      continue;
    }
    if (!dirent.isFile()) {
      addMaterial({ ...rec, readStatus: 'skipped', disposition: 'out_of_scope',
        reason: 'not_a_regular_file', note: '不是普通文件' });
      continue;
    }

    const abs = path.join(root, rel);
    let size, head, contentHash;
    try {
      size = (await fsp.stat(abs)).size;
      const fh = await fsp.open(abs, 'r');
      try {
        const buf = Buffer.alloc(16);
        await fh.read(buf, 0, 16, 0);
        head = buf;
      } finally {
        await fh.close();
      }
      contentHash = await hashFile(abs);
    } catch (err) {
      addMaterial({ ...rec, readStatus: 'unreadable', disposition: 'pending',
        reason: 'read_error', note: err.message });
      continue;
    }

    if (size === 0) {
      addMaterial({ ...rec, size, contentHash, readStatus: 'ok', format: 'empty',
        disposition: 'pending', reason: 'empty_file', note: '空文件，不能静默跳过' });
      continue;
    }

    const det = detectFormat(head);
    const normExt = rec.extHint ? rec.extHint.slice(1).replace('jpeg', 'jpg') : null;
    const extMismatch = det.supported && normExt !== null && normExt !== det.format;
    addMaterial({
      ...rec, size, contentHash, readStatus: 'ok', format: det.format,
      // 本切片只做到"格式已识别、等待解析"；
      // 主要报销凭证 / 参考材料的角色判定属于下一片。
      disposition: det.supported ? 'pending_classification' : 'out_of_scope',
      reason: det.supported ? null : 'unsupported_format',
      note: det.note ?? null,
      ...(extMismatch
      ? { extMismatch: true, extNote: `扩展名 ${rec.extHint} 与实际内容 ${det.format} 不符，以内容为准` }
        : {}),
    });
  }

  for (const expected of normalizedScope?.exclusions ?? []) {
    if (!scopeObserved.has(expected.relPath)) {
      scopeMismatches.push({ relPath: expected.relPath, status: 'missing', expected, actual: null });
    }
  }

  // 同一份内容出现在多个路径上 —— 这是"文件完全相同"的强证据，
  // 但按契约它不等于法定重复发票，只作提示，判定留给发票身份那一层。
  const byHash = new Map();
  for (const m of materials) {
    if (!m.contentHash) continue;
    if (!byHash.has(m.contentHash)) byHash.set(m.contentHash, []);
    byHash.get(m.contentHash).push(m.materialId);
  }
  const duplicateContent = [...byHash.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([contentHash, materialIds]) => ({ contentHash, materialIds }));

  // 盘点版本由"每份材料的路径 + 内容哈希 + 大小"决定：
  // 新增、删除或内容变化都会产生新版本，旧的 ERP 就绪快照随之失效。
  const versionParts = [
    ...materials.map((m) => `${m.relPath} ${m.contentHash ?? m.readStatus} ${m.size ?? ''}`),
    ...scopeMismatches.map((m) => `scope:${m.relPath} ${JSON.stringify(m.expected)} ${JSON.stringify(m.actual)}`),
  ];
  const versionId = 'v-' + crypto.createHash('sha256')
    .update(versionParts.join('\n'))
    .digest('hex').slice(0, 12);

  return { versionId, takenAt: new Date().toISOString(), materials, ignored, excluded,
    scope: normalizedScope, scopeMismatches, duplicateContent };
}

/** All task-aware readers use the task's explicit scope; a plain inventory remains unscoped. */
export async function takeInventoryForTask(sourceDir, task) {
  return takeInventory(sourceDir, { scope: task?.materialScope ?? null });
}

/** 本切片能产生的待确认项：只有盘点层面的，解析层面的属于下一片。 */
export function intakeOpenItems(inventory) {
  const items = [];
  for (const m of inventory.materials) {
    if (m.disposition === 'pending' || m.disposition === 'out_of_scope') {
      items.push({ kind: m.reason, materialId: m.materialId, fileName: m.fileName, note: m.note, blocking: true });
    }
    if (m.extMismatch) {
      items.push({ kind: 'extension_mismatch', materialId: m.materialId, fileName: m.fileName, note: m.extNote, blocking: false });
    }
  }
  for (const d of inventory.duplicateContent) {
    items.push({ kind: 'duplicate_content', materialIds: d.materialIds, blocking: false,
      note: '多个路径上是完全相同的文件；是否构成重复发票由发票身份判定，本层不下结论' });
  }
  for (const mismatch of inventory.scopeMismatches ?? []) {
    items.push({ kind: 'material_scope_mismatch', materialId: null,
      fileName: mismatch.relPath, blocking: true,
      note: `显式排除材料 ${mismatch.relPath} 的内容或大小已变化；需重新明确记录后才能继续` });
  }
  return items;
}
