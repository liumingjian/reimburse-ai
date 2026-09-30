import type { ReactNode } from 'react';

// Summary bar (摘要条, DESIGN.md「摘要条」): full bleed under the page header, fields of equal width filling the row,
// a divider between fields. Values come from the server; the page never computes them. A bar holds display only: an
// edit affordance goes to the page's actions so the bar keeps one height.
export function SummaryBar({ label, children }: { label: string; children: ReactNode }) {
  return (
    <dl className="app-summary bleed" aria-label={label}>
      {children}
    </dl>
  );
}

export type SummaryFieldProps = {
  readonly label: string;
  readonly value: ReactNode;
  // Decorative second channel (aria-hidden); the text carries the meaning.
  readonly icon?: ReactNode;
  // 价税合计: one size up.
  readonly total?: boolean;
  // A sentence-long value (对账结果) takes two columns.
  readonly wide?: boolean;
  readonly mono?: boolean;
  readonly testId?: string;
};

export function SummaryField({ label, value, icon = null, total = false, wide = false, mono = false, testId }: SummaryFieldProps) {
  const cls = ['app-summary-field', total ? 'app-summary-total' : '', wide ? 'app-summary-wide' : ''].filter(Boolean).join(' ');
  return (
    <div className={cls}>
      <dt className="app-summary-key">{label}</dt>
      <dd className={mono ? 'app-summary-value app-code' : 'app-summary-value'} {...(testId ? { 'data-testid': testId } : {})}>
        {icon}
        {value}
      </dd>
    </div>
  );
}
