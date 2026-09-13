import { Fragment, useState } from 'react';
import { Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Tag } from '@carbon/react';
import { CheckmarkFilled, ErrorFilled } from '@carbon/icons-react';
import type { ReadbackRow } from '../contract/snapshot';

// 逐条回读表：本地确认 vs 报销系统回读。一致与否由服务端按 9 个字段逐行判定（row.matched、field.matched），页面只按标志着色。
// 行上显示申请报销金额两边的值；不一致的行可以展开，列出服务端判为对不上的字段（「字段 本地 X / 报销系统 Y」）与这一行的原因。
// 合计也来自服务端，页面不求和。宽表规则：窗口窄时横向滚动，No. 固定在左、比对列固定在右。

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
    <div className="bleed app-table app-readback">
      <Table aria-label={label} size="md">
        <TableHead>
          <TableRow>
            <TableHeader className="app-no app-sticky-start">No.</TableHeader>
            <TableHeader>说明</TableHeader>
            <TableHeader className="app-num">本地申请报销金额</TableHeader>
            <TableHeader className="app-num">报销系统回读</TableHeader>
            <TableHeader className="app-sticky-end">比对</TableHeader>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((row) => {
            const gross = row.fields.find((field) => field.label === '申请报销金额') ?? null;
            const open = expanded.has(row.no);
            const detailId = `readback-detail-${row.no}`;
            return (
              <Fragment key={row.no}>
                <TableRow className={row.matched ? '' : 'app-row-mismatch'} data-testid={`readback-${row.no}`}>
                  <TableCell className="app-no app-sticky-start">{row.no}</TableCell>
                  <TableCell>{row.description}</TableCell>
                  <TableCell className="app-num">{gross?.local ?? ''}</TableCell>
                  <TableCell className="app-num">{gross ? (gross.erp ?? '未读到') : ''}</TableCell>
                  <TableCell className="app-sticky-end app-nowrap">
                    {row.matched ? (
                      <Tag type="green" size="sm" renderIcon={CheckmarkFilled}>
                        一致
                      </Tag>
                    ) : (
                      <span className="app-cell-actions">
                        <Tag type="red" size="sm" renderIcon={ErrorFilled}>
                          不一致
                        </Tag>
                        <Button
                          kind="ghost"
                          size="sm"
                          aria-expanded={open}
                          aria-controls={detailId}
                          aria-label={`${open ? '收起' : '展开'} No.${row.no}`}
                          onClick={() => toggle(row.no)}
                        >
                          {open ? '收起' : '展开'}
                        </Button>
                      </span>
                    )}
                  </TableCell>
                </TableRow>
                {!row.matched && open ? (
                  <TableRow id={detailId} data-testid={detailId} className="app-row-detail">
                    <TableCell colSpan={5}>
                      <p className="app-caption">对不上的字段</p>
                      <ul className="app-reconcile-reasons" aria-label={`No.${row.no} 对不上的字段`}>
                        {row.fields
                          .filter((field) => !field.matched)
                          .map((field) => (
                            <li key={field.label}>{fieldText(field.label, field.local, field.erp)}</li>
                          ))}
                      </ul>
                      {row.reasons.length > 0 ? (
                        <>
                          <p className="app-caption">原因</p>
                          <ul className="app-reconcile-reasons" aria-label={`No.${row.no} 原因`}>
                            {row.reasons.map((reason) => (
                              <li key={reason}>{reason}</li>
                            ))}
                          </ul>
                        </>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ) : null}
              </Fragment>
            );
          })}
        </TableBody>
        {localTotal !== null || erpTotal !== null ? (
          <tfoot>
            <TableRow>
              <TableCell className="app-sticky-start" />
              <TableCell>合计</TableCell>
              <TableCell className="app-num" data-testid="readback-local-total">
                {localTotal ?? ''}
              </TableCell>
              <TableCell className="app-num" data-testid="readback-erp-total">
                {erpTotal ?? ''}
              </TableCell>
              <TableCell className="app-sticky-end" />
            </TableRow>
          </tfoot>
        ) : null}
      </Table>
    </div>
  );
}
