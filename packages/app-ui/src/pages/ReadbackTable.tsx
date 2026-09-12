import type { ReadbackRow } from '../contract/snapshot';

// 逐条回读表：本地确认 vs ERP 回读。是否一致由服务端逐行判定（matched），页面只按标志着色：
// 一致 = success，ERP 读不到 = warning「需人工核对」，不一致 = danger。合计也来自服务端，页面不求和。
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
  return (
    <table className="data readback" aria-label={label}>
      <thead>
        <tr>
          <th className="num">No.</th>
          <th>说明</th>
          <th className="num">本地确认</th>
          <th className="num">ERP 回读</th>
          <th>比对</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.no} className={row.matched ? undefined : row.erp === null ? 'row-warn' : 'row-err'} data-testid={`readback-${row.no}`}>
            <td className="num">{row.no}</td>
            <td>{row.description}</td>
            <td className="num">{row.local}</td>
            <td className="num">{row.erp ?? '未读到'}</td>
            <td>
              {row.matched ? (
                <span className="badge badge-ok">一致</span>
              ) : row.erp === null ? (
                <span className="badge badge-warn">需人工核对</span>
              ) : (
                <span className="badge badge-err">不一致</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
      {localTotal !== null || erpTotal !== null ? (
        <tfoot>
          <tr>
            <td colSpan={2}>合计</td>
            <td className="num" data-testid="readback-local-total">
              {localTotal ?? ''}
            </td>
            <td className="num" data-testid="readback-erp-total">
              {erpTotal ?? ''}
            </td>
            <td />
          </tr>
        </tfoot>
      ) : null}
    </table>
  );
}
