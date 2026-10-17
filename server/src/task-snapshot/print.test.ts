import { STAY_TRIO_COPY } from '@baox/contract';
import { describe, expect, it } from 'vitest';
import type { StayTrio } from '../stay-trio';
import type { PrintFacts, StoredPage } from '../print/facts';
import { unrecordedScreenshotNotice } from '../print/layout';
import { printView } from './print';

// The missing-screenshot notice on a generated sheet (#213). The inventory's 住宿 trio record decides it where there
// is one; a 住宿 page without a record (a task inventoried before the trio check) still gets a notice.

const page = (voucherMaterialId: string, no: number, categoryLabel: string, screenshotIds: string[] = []): StoredPage => ({
  pageId: `page.${voucherMaterialId}`,
  kind: 'voucher',
  voucherMaterialId,
  no,
  nos: `No.${no}`,
  header: '',
  date: '2026-08-09',
  categoryLabel,
  grossAmount: '100.00',
  pngSha256: 'png',
  top: null,
  bottom: null,
  screenshotIds,
});
const facts = (pages: StoredPage[]): PrintFacts => ({ render: { renderId: 'r', confirmationRevision: 1, pdfSha256: 'pdf', pages }, settings: new Map(), screenshots: [], placed: [], completeGroups: new Set() });
const trio = (invoiceId: string, noneConfirmed: boolean): StayTrio => ({
  invoiceId,
  folioId: null,
  invoice: { present: true, noneConfirmed: false },
  folio: { present: false, noneConfirmed: true },
  screenshot: { present: false, noneConfirmed },
});
const notices = (pages: StoredPage[], trios: StayTrio[]) => printView('t', '任务', facts(pages), 'generated', trios).printSheet.notices;

describe('printView missing-screenshot notice', () => {
  it('follows the inventory record where there is one', () => {
    expect(notices([page('a', 1, '住宿'), page('b', 2, '住宿')], [trio('a', true), trio('b', false)])).toEqual([STAY_TRIO_COPY.printNotice('No.1', '住宿')]);
  });

  it('still notices a 住宿 page with no screenshot and no record, and only a 住宿 one', () => {
    expect(notices([page('a', 1, '住宿'), page('t', 2, '长途交通')], [])).toEqual([unrecordedScreenshotNotice('No.1', '住宿')]);
  });

  it('says nothing for a page that has its screenshot', () => {
    expect(notices([page('a', 1, '住宿', ['s1'])], [])).toEqual([]);
    expect(notices([page('a', 1, '住宿', ['s1'])], [trio('a', true)])).toEqual([]);
  });

  it('says nothing for a page whose screenshots moved to its continuation page (#333)', () => {
    const continuation: StoredPage = { ...page('a', 1, '住宿', ['s1', 's2']), pageId: 'page.a.screenshots', kind: 'screenshots', hotelName: null };
    expect(notices([page('a', 1, '住宿'), continuation], [])).toEqual([]);
  });
});
