import type { ReactNode } from 'react';
import { ButtonSet } from '@carbon/react';
import { ActionError } from './ActionError';

// In-content button group (DESIGN.md「版式统一」): Carbon ButtonSet, so the buttons sit in one row at one width and
// height. Callers pass `size="md"` buttons, at most one primary, primary last. The caption and the action error go
// under the whole group, never between buttons.
export function ActionGroup({
  children,
  caption,
  error = null,
  label,
  className,
}: {
  children: ReactNode;
  caption?: ReactNode;
  error?: string | null;
  label?: string;
  className?: string;
}) {
  return (
    <div className={className ? `app-action-group ${className}` : 'app-action-group'} {...(label ? { role: 'group', 'aria-label': label } : {})}>
      <ButtonSet>{children}</ButtonSet>
      {caption ? <p className="app-caption">{caption}</p> : null}
      <ActionError message={error} />
    </div>
  );
}
