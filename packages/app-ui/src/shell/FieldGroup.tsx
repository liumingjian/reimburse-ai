import type { ReactNode } from 'react';

// 带标签的字段组：灰色小标签（label-01）加值，字段之间留间距。写法与摘要条的字段一致，但不通栏、不带底色。
// 用它代替页面自己拼的「A · B · C」中点串（DESIGN.md「标题与版式」）。
export type Field = { readonly label: string; readonly value: ReactNode };

export function FieldGroup({ fields, label }: { fields: readonly Field[]; label?: string }) {
  return (
    <dl className="app-fields" {...(label ? { 'aria-label': label } : {})}>
      {fields.map((field) => (
        <div key={field.label} className="app-field">
          <dt className="app-field-key">{field.label}</dt>
          <dd className="app-field-value">{field.value}</dd>
        </div>
      ))}
    </dl>
  );
}
