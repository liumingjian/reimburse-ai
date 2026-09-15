import { useId, type ReactNode } from 'react';

// 带标签的只读字段组：灰字标签 + 值，值下可带一行说明。用在「看得见、改不了」的地方（启动页身份、新建弹层的报销人），
// 不画成输入框，也不拿表头当行标题。每个值经 aria-labelledby 指向自己的标签，读屏与按标签定位都能找到。
export type ReadOnlyField = { readonly term: string; readonly value: ReactNode; readonly note?: string; readonly code?: boolean };

export function ReadOnlyFields({ label, fields }: { label?: string; fields: readonly ReadOnlyField[] }) {
  const id = useId();
  return (
    <dl className="app-kv app-readonly-fields" aria-label={label}>
      {fields.map((field, index) => (
        <div key={field.term} className="app-kv-row">
          <dt id={`${id}-${index}`}>{field.term}</dt>
          <dd aria-labelledby={`${id}-${index}`}>
            <span className={field.code ? 'app-code' : undefined}>{field.value}</span>
            {field.note ? <span className="app-readonly-note">{field.note}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}
