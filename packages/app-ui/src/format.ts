import type { TaskPeriod } from './contract/task-list';

// 只做展示格式化，不做业务计算。

export function formatDateTime(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

export function formatPeriod(period: TaskPeriod | null): string {
  if (!period) return '未定';
  return period.start === period.end ? period.start : `${period.start} 至 ${period.end}`;
}

// 文件大小：与原型一致，KB 取整、MB 保留一位。
export function formatBytes(size: number): string {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

// 内容哈希只显示前 8 位作为身份。
export function hashPrefix(contentHash: string): string {
  return `sha256:${contentHash.slice(0, 8)}`;
}
