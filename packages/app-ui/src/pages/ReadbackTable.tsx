import { Fragment, useState } from 'react';
import type { ReadbackRow } from '../contract/snapshot';
import { Icon } from '../shell/Icon';

// 逐条回读表：本地确认 vs 报销系统回读。一致与否由服务端按 9 个字段逐行判定（row.matched、field.matched），页面只按标志着色。
// 行上显示申请报销金额两边的值；不一致的行可以展开，列出服务端判为对不上的字段（「字段 本地 X / 报销系统 Y」）与这一行的原因。
// 合计也来自服务端，页面不求和。宽表规则（DESIGN.md）：窗口窄时横向滚动，No. 固定在左、比对列固定在右。

function fieldText(label: string, local: string | null, erp: string | null): string {
  return `${label} 本地 ${local ?? '无'} / 报销系统 ${erp ?? '未读到'}`;
}

export function ReadbackTable({
  label,
  rows,
  localTotal,
  erpTotal,
}: {
  label: string;
  rows: readonly ReadbackRow[];
  localTotal: string | null;
  erpTotal: string | null;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const toggle = (no: number) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(no)) next.delete(no);
      else next.add(no);
      return next;
    });

  return (
    <div className="table-scroll bleed">
      <table className="data readback" aria-label={label}>
        <thead>
          <tr>
            <th className="num sticky-start">No.</th>
            <th>说明</th>
            <th className="num">本地申请报销金额</th>
            <th className="num">报销系统回读</th>
            <th className="sticky-end">比对</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const gross = row.fields.find((field) => field.label === '申请报销金额') ?? null;
            const open = expanded.has(row.no);
            const detailId = `readback-detail-${row.no}`;
            return (
              <Fragment key={row.no}>
                <tr className={row.matched ? undefined : 'row-err'} data-testid={`readback-${row.no}`}>
                  <td className="num sticky-start">{row.no}</td>
                  <td>{row.description}</td>
                  <td className="num">{gross?.local ?? ''}</td>
                  <td className="num">{gross ? (gross.erp ?? '未读到') : ''}</td>
                  <td className="sticky-end nowrap">
                    {row.matched ? (
                      <span className="tag tag-success">
                        <Icon name="checkmark--filled" />
                        一致
                      </span>
                    ) : (
                      <span className="cell-actions">
                        <span className="tag tag-danger">
                          <Icon name="error--filled" />
                          不一致
                        </span>
                        <button
                          className="btn btn-tertiary btn-sm"
                          type="button"
                          aria-expanded={open}
                          aria-controls={detailId}
                          aria-label={`${open ? '收起' : '展开'} No.${row.no}`}
                          onClick={() => toggle(row.no)}
                        >
                          {open ? '收起' : '展开'}
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
                {!row.matched && open ? (
                  <tr id={detailId} data-testid={detailId} className="row-detail">
                    <td colSpan={5}>
                      <p className="caption">对不上的字段</p>
                      <ul className="reconcile-reasons" aria-label={`No.${row.no} 对不上的字段`}>
                        {row.fields
                          .filter((field) => !field.matched)
                          .map((field) => (
                            <li key={field.label}>{fieldText(field.label, field.local, field.erp)}</li>
                          ))}
                      </ul>
                      {row.reasons.length > 0 ? (
                        <>
                          <p className="caption">原因</p>
                          <ul className="reconcile-reasons" aria-label={`No.${row.no} 原因`}>
                            {row.reasons.map((reason) => (
                              <li key={reason}>{reason}</li>
                            ))}
                          </ul>
                        </>
                      ) : null}
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
        {localTotal !== null || erpTotal !== null ? (
          <tfoot>
            <tr>
              <td className="sticky-start" />
              <td>合计</td>
              <td className="num" data-testid="readback-local-total">
                {localTotal ?? ''}
              </td>
              <td className="num" data-testid="readback-erp-total">
                {erpTotal ?? ''}
              </td>
              <td className="sticky-end" />
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}
