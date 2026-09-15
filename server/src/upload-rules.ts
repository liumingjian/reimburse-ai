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

export function rejectReason(code: UploadRejectCode, duplicateOf?: string): string {
  if (code === 'duplicate_content' && duplicateOf) return `${UPLOAD_REJECT_MESSAGES.duplicate_content}，与已接收的「${duplicateOf}」内容相同`;
  return UPLOAD_REJECT_MESSAGES[code];
}
