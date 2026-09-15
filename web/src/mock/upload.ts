import {
  UPLOAD_ACCEPTED_EXTENSIONS,
  UPLOAD_MAX_FILE_BYTES,
  UPLOAD_REJECT_MESSAGES,
  type UploadRejectCode,
} from '@baox/contract';

// mock 里的上传接收规则：与服务端约定相同（扩展名/MIME、20MB、HEIC、内容哈希重复），在浏览器内逐文件判定。
// 页面不复制这些规则，只显示结果。

export type FileVerdict = { status: 'accepted'; contentHash: string } | { status: 'rejected'; reasonCode: UploadRejectCode; reason: string };

const HEIC_EXTENSIONS = ['heic', 'heif'];
const HEIC_MIMES = ['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence'];
const MIME_EXTENSION: Readonly<Record<string, string>> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };

export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot < 0 ? '' : fileName.slice(dot + 1).toLowerCase();
}

// 类型判定：先看扩展名；没有扩展名时退到 MIME。扩展名与 MIME 都不认识才算类型不支持。
function typeVerdict(file: File): UploadRejectCode | null {
  const ext = extensionOf(file.name);
  const mime = (file.type || '').toLowerCase();
  if (HEIC_EXTENSIONS.includes(ext) || HEIC_MIMES.includes(mime)) return 'heic';
  if ((UPLOAD_ACCEPTED_EXTENSIONS as readonly string[]).includes(ext)) return null;
  if (ext === '' && MIME_EXTENSION[mime]) return null;
  return 'unsupported_type';
}

export async function judgeFile(file: File, knownHashes: ReadonlyMap<string, string>): Promise<FileVerdict> {
  const type = typeVerdict(file);
  if (type) return { status: 'rejected', reasonCode: type, reason: UPLOAD_REJECT_MESSAGES[type] };
  if (file.size > UPLOAD_MAX_FILE_BYTES) return { status: 'rejected', reasonCode: 'too_large', reason: UPLOAD_REJECT_MESSAGES.too_large };
  const contentHash = await hashFile(file);
  const existing = knownHashes.get(contentHash);
  if (existing) return { status: 'rejected', reasonCode: 'duplicate_content', reason: duplicateReason(existing) };
  return { status: 'accepted', contentHash };
}

export function duplicateReason(existingFileName: string): string {
  return `${UPLOAD_REJECT_MESSAGES.duplicate_content}，与已接收的「${existingFileName}」内容相同`;
}

// 内容哈希：优先 SubtleCrypto 的 sha256；没有时用 FNV-1a 拼出同样形状的 64 位十六进制（jsdom 等环境）。
export async function hashFile(file: File): Promise<string> {
  const bytes = await readBytes(file);
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    try {
      const digest = await subtle.digest('SHA-256', bytes);
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch {
      // 退到下面的廉价哈希。
    }
  }
  return cheapHash(new Uint8Array(bytes));
}

async function readBytes(file: File): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
    reader.readAsArrayBuffer(file);
  });
}

function cheapHash(bytes: Uint8Array): string {
  let out = '';
  for (let round = 0; round < 8; round += 1) {
    let h = (0x811c9dc5 ^ (round * 0x9e3779b9)) >>> 0;
    for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0;
    h = Math.imul(h ^ bytes.length, 0x01000193) >>> 0;
    out += h.toString(16).padStart(8, '0');
  }
  return out;
}
