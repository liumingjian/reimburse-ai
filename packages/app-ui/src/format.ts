import type { TaskPeriod } from './contract/task-list';

// 只做展示格式化，不做业务计算。

export function formatDateTime(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

export function formatPeriod(period: TaskPeriod | null): string {
  if (!period) return '未定';
  return period.start === period.end ? period.start : `${period.start} 至 ${period.end}`;
}
