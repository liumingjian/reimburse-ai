import type { ReactNode } from 'react';
import { Tile } from '@carbon/react';

// Card (卡片, DESIGN.md「版式统一」): a Carbon Tile with one padding. Cards in a CardRow share a row height, and each
// card pins its actions to the bottom, so the buttons of neighbouring cards line up whatever the text above them.
export function Card({
  title,
  children,
  actions,
  label,
  className,
}: {
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  label?: string;
  className?: string;
}) {
  return (
    <Tile className={className ? `app-card ${className}` : 'app-card'} {...(label ? { 'aria-label': label, role: 'region' } : {})}>
      {title ? <h3 className="app-card-title">{title}</h3> : null}
      {children ? <div className="app-card-body">{children}</div> : null}
      {actions ? <div className="app-card-actions">{actions}</div> : null}
    </Tile>
  );
}

// Equal-width columns, 1px dividers between cards.
export function CardRow({ children, bleed = false, label }: { children: ReactNode; bleed?: boolean; label?: string }) {
  return (
    <div className={bleed ? 'app-card-row bleed' : 'app-card-row'} {...(label ? { role: 'group', 'aria-label': label } : {})}>
      {children}
    </div>
  );
}
