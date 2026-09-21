// Read-only: the verbatim text of every ERP `.k-window`, visible or not — in practice the 处理结果 report the
// 发票导入单据 click leaves behind, with its 执行成功／执行失败 summary and one line per invoice.
//
// A hidden window still holds the last import's verdict, which is how a run that already ended can still be asked
// what ERP said about each invoice. It reads; it clicks nothing.
import { connect, evalIn, targets } from '../src/erp/executor/cdp';
import { cdpPortOf } from '../src/erp/executor/chromium';
const erp = (await targets(cdpPortOf())).find((t) => t.type === 'page' && String(t.url).includes('erp.antute.com.cn'));
if (!erp) { console.error('no ERP page open'); process.exit(1); }
const session = await connect(erp.webSocketDebuggerUrl!);
try {
  const out = await evalIn<string[]>(session, `[...document.querySelectorAll('.k-window')].map((n) => String(n.textContent || '').replace(/\\s+/g, ' ').trim())`);
  for (const t of out) console.log(t);
} finally { session.close(); }
