import type { ReactNode } from 'react';

// 页头：标题（Carbon heading-04）与标题下最多一句导语；右侧放页面主按钮。导语后可跟一个说明入口（children）。
// titleId：页面里的表格用标题作可访问名称时（aria-labelledby）给标题一个 id。
export function PageHeader({
  title,
  titleId,
  lead,
  children,
  actions,
}: {
  title: string;
  titleId?: string;
  lead?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="app-page-head">
      <div>
        <h1 className="app-page-title" {...(titleId ? { id: titleId } : {})}>
          {title}
        </h1>
        {lead ? (
          <p className="app-lead">
            {lead}
            {children}
          </p>
        ) : (
          children
        )}
      </div>
      {actions ? <div className="app-page-actions">{actions}</div> : null}
    </div>
  );
}
