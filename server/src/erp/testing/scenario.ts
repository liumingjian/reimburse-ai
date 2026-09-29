// The server's half of the two-invoice fill scenario. The ERP side (invoices, catalog, plans, the fake ERP's
// options) lives next to the fake ERP in @baox/erp-executor/testing/scenario and is re-exported here; what stays is
// the task facts the server's judge turns into the approved preview.

import type { DraftJudgeInputs } from '../judge';
import { previewLinesDigest } from '../preview';
import { EXPENSE_ITEMS, IDENTITY, INVOICES, PROJECTS } from '@baox/erp-executor/testing/scenario';

export {
  blobSource, COMPATIBILITY, ERP_ACCOUNT, ERP_ORIGIN, EXPENSE_ITEMS, FAST_PACE, fakeErpOptions, fillPlan, IDENTITY, INVOICES,
  PROJECTS, reconcilePlan, withoutLayout,
} from '@baox/erp-executor/testing/scenario';

/** The server-side facts the judge turns into the approved preview (kernel shapes). */
export const judgeInputs = (taskId: string): DraftJudgeInputs => {
  const events = [
    { eventId: 'ev-1', voucherMaterialId: 'm-rail', kind: 'rail_eticket' },
    { eventId: 'ev-2', voucherMaterialId: 'm-ride', kind: 'passenger_transport' },
  ];
  const built = {
    versionId: 'v-1', events,
    lineItems: [
      { lineId: 'ev-1', eventId: 'ev-1', voucherMaterialId: 'm-rail', kind: 'rail_eticket', date: '2026-08-22', city: null,
        route: '合肥南 → 广州南', netAmount: null, taxAmount: null, totalAmount: '703.00', category: 'long_distance',
        invoiceType: '普通发票', invoiceTypeSource: 'fixture_mapping' },
      { lineId: 'ev-2', eventId: 'ev-2', voucherMaterialId: 'm-ride', kind: 'passenger_transport', date: '2026-08-27', city: '广州',
        route: '番禺广场地铁站D口 → 傍西酒堂', netAmount: '50.12', taxAmount: '1.51', totalAmount: '51.63', category: 'local_city_transport',
        invoiceType: '普通发票', invoiceTypeSource: 'fixture_mapping' },
    ],
  };
  const codes = [['39163', 'FY010003', '长途交通'], ['38480', 'FY008001', '本地市内交通']] as const;
  const lines = built.lineItems.map((line, index) => ({
    ...line, projectCode: codes[index]![0], projectSource: 'erp_catalog_confirmed', projectsFrom: 'project_book',
    expenseItemCode: codes[index]![1], expenseItemName: codes[index]![2],
  }));
  const digest = previewLinesDigest(built);
  return {
    task: { taskId, currentVersionId: built.versionId, identity: IDENTITY, homeCity: '合肥' },
    built, lines,
    selection: {
      versionId: built.versionId, linesDigest: digest, identity: IDENTITY, homeCity: '合肥', purpose: '客户支持',
      projects: Object.fromEntries(lines.map((line) => [line.lineId, line.projectCode])),
      projectSource: 'erp_catalog_confirmed', projectsFrom: 'project_book',
    },
    catalog: {
      versionId: built.versionId, linesDigest: digest, identity: IDENTITY,
      projects: Object.fromEntries(PROJECTS.map((p) => [p.code, { ...p, verdict: 'confirmed' }])),
    },
    expenseItems: Object.fromEntries(EXPENSE_ITEMS.map((e) => [e.code, { ...e, verdict: 'confirmed' }])),
    invoices: INVOICES.map((invoice) => ({ materialId: invoice.materialId, identity: { key: `einvoice-20:${invoice.invoiceNumber}`, number: invoice.invoiceNumber } })),
  };
};
