import path from 'node:path';

export const MATERIAL_SCOPE_SCHEMA_VERSION = 1;

const CONTROL = /[\u0000-\u001f\u007f]/;
const HASH = /^[a-f0-9]{64}$/;

const text = (value, label) => {
  if (typeof value !== 'string' || !value.trim() || CONTROL.test(value)) {
    throw new TypeError(`${label} 必须是非空文本`);
  }
  return value.trim();
};

const relativePath = (value) => {
  const rel = text(value, 'exclusions[].relPath').replaceAll('\\', '/');
  const normalized = path.posix.normalize(rel);
  if (rel !== normalized || normalized === '.' || normalized.startsWith('../')
    || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    throw new TypeError(`exclusions[].relPath 不是材料根目录内的稳定相对路径：${value}`);
  }
  return normalized;
};

export function normalizeMaterialScope(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('material scope 必须是对象');
  }
  const schemaVersion = Number(value.schemaVersion ?? MATERIAL_SCOPE_SCHEMA_VERSION);
  if (schemaVersion !== MATERIAL_SCOPE_SCHEMA_VERSION) {
    throw new TypeError(`material scope schemaVersion 必须是 ${MATERIAL_SCOPE_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(value.exclusions) || value.exclusions.length === 0) {
    throw new TypeError('material scope 必须包含至少一条显式 exclusions');
  }
  const seen = new Set();
  const exclusions = value.exclusions.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new TypeError(`exclusions[${index}] 不是对象`);
    }
    const relPath = relativePath(item.relPath);
    if (seen.has(relPath)) throw new TypeError(`exclusions 有重复 relPath：${relPath}`);
    seen.add(relPath);
    const contentHash = text(item.contentHash, `exclusions[${index}].contentHash`);
    if (!HASH.test(contentHash)) {
      throw new TypeError(`exclusions[${index}].contentHash 必须是 64 位小写 sha256`);
    }
    if (!Number.isSafeInteger(item.size) || item.size < 0) {
      throw new TypeError(`exclusions[${index}].size 必须是非负整数`);
    }
    const reason = text(item.reason, `exclusions[${index}].reason`);
    return { relPath, contentHash, size: item.size, reason };
  }).sort((a, b) => a.relPath.localeCompare(b.relPath));
  return { schemaVersion: MATERIAL_SCOPE_SCHEMA_VERSION, exclusions };
}
