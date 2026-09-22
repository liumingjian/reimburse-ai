import { UPLOAD_ACCEPTED_EXTENSIONS, UPLOAD_MAX_FILE_BYTES, UPLOAD_REJECT_MESSAGES, type UploadRejectCode } from '@baox/contract';

// Per-file acceptance rules for an 上传批次 (upload batch), the same as the mock's (web/src/mock/upload.ts):
// HEIC first, then type by extension (MIME only when there is no extension), then size. Content duplicates are
// judged by the task service, which knows the task's materials.

const HEIC_EXTENSIONS = ['heic', 'heif'];
const HEIC_MIMES = ['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence'];
const MIME_EXTENSION: Readonly<Record<string, string>> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot < 0 ? '' : fileName.slice(dot + 1).toLowerCase();
}

export function rejectByShape(fileName: string, mime: string, size: number): UploadRejectCode | null {
  const ext = extensionOf(fileName);
  const type = mime.toLowerCase();
  if (HEIC_EXTENSIONS.includes(ext) || HEIC_MIMES.includes(type)) return 'heic';
  const known = (UPLOAD_ACCEPTED_EXTENSIONS as readonly string[]).includes(ext) || (ext === '' && MIME_EXTENSION[type] !== undefined);
  if (!known) return 'unsupported_type';
  if (size > UPLOAD_MAX_FILE_BYTES) return 'too_large';
  return null;
}

const EXTENSION_MIME: Readonly<Record<string, string>> = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };

// Browser directory pickers provide `webkitRelativePath`, while single-file pickers only provide a name. Keep the
// path as display provenance, but never allow an absolute path or a parent-directory segment into the task facts.
export function sourceFileName(fileName: string): string {
  const normalized = fileName.replaceAll('\\', '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1) || '未命名文件';
}

export function relativeSourcePath(fileName: string, relativePath?: string | null): string {
  const fallback = sourceFileName(fileName);
  const raw = (relativePath ?? '').replaceAll('\\', '/');
  if (!raw || raw.startsWith('/') || /^[A-Za-z]:\//.test(raw) || raw.includes('\u0000')) return fallback;
  const parts = raw.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.length === 0 || parts.some((part) => part === '..')) return fallback;
  const leaf = parts.at(-1);
  return leaf ? parts.join('/') : fallback;
}

// The content type a stored original is kept and served under. Never the type the uploading browser claimed: blobs are
// content-addressed and shared between accounts (the first upload's type would win for everyone), and the file is
// served back from this origin, so a claimed `text/html` or `image/svg+xml` would be stored XSS. Derived from the
// accepted extension, falling back to the client type only when it is one of the three kinds uploads accept.
export function storedMime(fileName: string, mime: string): string {
  const byExtension = EXTENSION_MIME[extensionOf(fileName)];
  if (byExtension) return byExtension;
  const canonical = MIME_EXTENSION[mime.toLowerCase()];
  return (canonical ? EXTENSION_MIME[canonical] : undefined) ?? 'application/octet-stream';
}

export function rejectReason(code: UploadRejectCode, duplicateOf?: string): string {
  if (code === 'duplicate_content' && duplicateOf) return `${UPLOAD_REJECT_MESSAGES.duplicate_content}，与已接收的「${duplicateOf}」内容相同`;
  return UPLOAD_REJECT_MESSAGES[code];
}
