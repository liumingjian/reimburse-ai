const SECRET_NAME = String.raw`(?:[A-Za-z0-9_-]*?(?:password|passwd|token|secret|credential|api[_-]?key|cookie)[A-Za-z0-9_-]*)`;
const JSON_SECRET = new RegExp(`("${SECRET_NAME}"\\s*:\\s*)"(?:\\\\.|[^"\\\\])*"`, 'gi');
const QUOTED_ASSIGNMENT_SECRET = new RegExp(`(["']${SECRET_NAME}["']\\s*[:=]\\s*)(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^\\s,;}\\]]+)`, 'gi');
const ASSIGNMENT_SECRET = new RegExp(`\\b(${SECRET_NAME})\\b\\s*([=:])\\s*(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^\\s,;}\\]]+)`, 'gi');
const AUTHORIZATION_SECRET = /\bauthorization\s*:\s*(?:bearer\s+)?[^\s,;}\]]+/gi;
const CHINESE_PASSWORD = /(临时密码|密码)\s*[：:]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/g;

export function redact(value: string): string {
  return value
    .replace(JSON_SECRET, '$1"[REDACTED]"')
    .replace(QUOTED_ASSIGNMENT_SECRET, '$1[REDACTED]')
    .replace(ASSIGNMENT_SECRET, '$1$2[REDACTED]')
    .replace(AUTHORIZATION_SECRET, 'authorization: [REDACTED]')
    .replace(CHINESE_PASSWORD, '$1：[REDACTED]');
}

export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactValue(entry)]));
}
