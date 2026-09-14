import type { ReactNode } from 'react';
import { Tag } from '@carbon/react';
import { CheckmarkFilled, ErrorFilled, InProgress, Locked, WarningAltFilled } from '@carbon/icons-react';

// 状态标签（DESIGN.md「状态标签」）：图标加文字，颜色只是第二通道。
// 一律用 Carbon Tag 的默认尺寸：Carbon 的 Tag 在 size="sm" 时不渲染 renderIcon，小号标签会丢掉图标，所以这里不接受 size。
// Tone picks colour and icon: info blue, success green, danger red, warning warm-gray with a warning icon,
// locked warm-gray with a lock. Every warning tag in the app goes through here; _app-rules.scss paints the warning
// icon like Carbon's warning notification (yellow fill, dark "!") via data-tone.
export type StatusTone = 'info' | 'success' | 'danger' | 'warning' | 'locked';

const TONE_TYPE = { info: 'blue', success: 'green', danger: 'red', warning: 'warm-gray', locked: 'warm-gray' } as const;
const TONE_ICON = { info: InProgress, success: CheckmarkFilled, danger: ErrorFilled, warning: WarningAltFilled, locked: Locked } as const;

export function StatusTag({ tone, children, as, className }: { tone: StatusTone; children: ReactNode; as?: 'span'; className?: string }) {
  return (
    <Tag type={TONE_TYPE[tone]} renderIcon={TONE_ICON[tone]} data-tone={tone} {...(as ? { as } : {})} className={className ? `app-status-tag ${className}` : 'app-status-tag'}>
      {children}
    </Tag>
  );
}
