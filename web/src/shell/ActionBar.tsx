import { useRef, type ReactNode } from 'react';
import { ButtonSet } from '@carbon/react';
import type { ActionLink } from '@baox/contract';
import { ActionError } from './ActionError';
import { useStickyHeight } from './useStickyHeight';

// Sticky bottom action bar (吸底操作栏, DESIGN.md「页面操作栏与并列入口」): spans the whole sheet and sticks to the
// viewport's bottom edge. Left: one consequence or summary line that does not repeat the page lead. Then an optional
// caption, then the actions in a Carbon ButtonSet (one width, one height) with the primary button last (rightmost).
// The action error wraps onto its own row.
// Contract for callers: default-size (lg) buttons, at most one `kind="primary"`; backward steps use `kind="ghost"`.
// `label` is the landmark's accessible name; e2e locators rely on it, so keep each page's existing wording.
export type ActionBarProps = {
  readonly label: string;
  readonly consequence: ReactNode;
  // Extra attributes for the consequence wrapper: a page-specific class, `role="status"` when the line is a live notice,
  // or a test id for the summary.
  readonly consequenceProps?: { readonly className?: string; readonly role?: 'status'; readonly 'data-testid'?: string };
  readonly caption?: ReactNode;
  readonly actions: ReactNode;
  readonly error?: string | null;
  // The page that can fix what `error` names (useAction's `errorLink`).
  readonly errorLink?: ActionLink | null;
};

export function ActionBar({ label, consequence, consequenceProps, caption, actions, error = null, errorLink = null }: ActionBarProps) {
  const { className, ...rest } = consequenceProps ?? {};
  const barRef = useRef<HTMLElement>(null);
  // Its height lets sticky page parts (the project panel) stop above it.
  useStickyHeight(barRef, '--app-action-bar-h');
  return (
    <section ref={barRef} className="app-action-bar" aria-label={label}>
      <div className={className ? `app-consequence ${className}` : 'app-consequence'} {...rest}>
        {consequence}
      </div>
      {caption ? <span className="app-caption">{caption}</span> : null}
      <ButtonSet>{actions}</ButtonSet>
      <ActionError message={error} link={errorLink} />
    </section>
  );
}
