// The executor against pages recorded from the live ERP (`probe new-form --record new-form`), not against the
// hand-written fixtures: the login fingerprint, the menu path to a new 费用报销单, and the compatibility fingerprint
// of the form it opens. Where a hand-written assumption is checked against the recording, the test says so.

import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { clickAt, evalIn } from './cdp';
import { headerFieldSnippet, type HeaderField } from './header-locator';
import { COMPATIBILITY_SNIPPET, probeIdentity } from './probe';
import { openNewReimbursement } from './steps';
import { createFakeErp, type FakeErp } from './testing/fake-erp';
import { loadRecording, recordingNames } from './testing/recordings';
import { COMPATIBILITY, ERP_ACCOUNT, ERP_ORIGIN, FAST_PACE } from './testing/scenario';

const recorded = (loggedIn = true) => createFakeErp({ recording: 'new-form', loggedIn, account: ERP_ACCOUNT, invoices: [], projects: [], expenseItems: [] });
const probe = (erp: FakeErp) => probeIdentity({
  origin: ERP_ORIGIN, waitMs: 1000, pollMs: 1, transport: 'chromium-cdp',
  listTabs: () => erp.browser.listPages(), evaluate: (_page, expression) => evalIn(erp.session, expression),
});

describe('the fake ERP replaying the live new-form recording', () => {
  it('reads the recorded console as a logged-in identity, the fake account filled into the placeholders', async () => {
    const result = await probe(await recorded());
    expect(result.status).toBe('matched');
    expect(result.identity).toEqual(ERP_ACCOUNT);
  });

  it('reads the recorded login page as not logged in', async () => {
    const result = await probe(await recorded(false));
    expect(result.status).toBe('not_logged_in');
  });

  it('opens a new 费用报销单 along the recorded path, and reads the fingerprint the hand-written fake assumes', async () => {
    const erp = await recorded();
    const { manifest } = loadRecording('new-form');
    expect(await openNewReimbursement({ session: erp.session, pace: FAST_PACE })).toEqual({ ok: true, form: '费用报销单-新增' });
    expect(erp.recordedPage).toBe('new-form');
    const fingerprint = await evalIn<{ erpBuild: string; formIds: string[] }>(erp.session, COMPATIBILITY_SNIPPET);
    // Build and form ids as the live run read them. `activePanels` is left out: live read 0 a moment before the page
    // was captured with 1, Kendo moving `k-state-active` onto the new form's panel late (probe.ts COMPATIBILITY_SNIPPET).
    const live = (manifest.result as { fingerprint: { erpBuild: string; formIds: string[] } }).fingerprint;
    expect({ erpBuild: fingerprint.erpBuild, formIds: fingerprint.formIds }).toEqual({ erpBuild: live.erpBuild, formIds: live.formIds });
    // scenario.ts COMPATIBILITY is what every hand-written test expects ERP to answer.
    expect({ erpBuild: fingerprint.erpBuild, formId: fingerprint.formIds[0] }).toEqual(COMPATIBILITY);
  });

  it('finds 事由 and 单据编号 on the recorded new form by the one header-field rule, both empty', async () => {
    const erp = await recorded();
    await openNewReimbursement({ session: erp.session, pace: FAST_PACE });
    for (const key of ['FCAUSA', 'FBILLNO']) {
      const field = await evalIn<HeaderField>(erp.session, headerFieldSnippet(key));
      expect(field, key).toMatchObject({ ok: true, visibleInstances: 1, value: '' });
    }
  });

  it('stays on the recorded page when a click lands anywhere but where the live click did', async () => {
    const erp = await recorded();
    const elsewhere = await evalIn<{ x: number; y: number }>(erp.session, `(() => {
      const target = [...document.querySelectorAll('body *')].find((n) => !n.hasAttribute('data-rec-click') && !n.querySelector('[data-rec-click]') && !n.closest('[data-rec-click]') && n.getBoundingClientRect().width > 0);
      const b = target.getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    })()`);
    await clickAt(erp.session, elsewhere.x, elsewhere.y);
    expect(erp.recordedPage).toBe('page-1');
  });
});

describe('committed recordings', () => {
  // Structure keeps its digits (ids, spans, the live boxes); values do not. The ERP build is the one value kept.
  const STRUCTURAL = /^(id|class|for|data-kdformid|colspan|rowspan|tabindex|data-rec-box)$/;
  it.each(recordingNames())('%s holds no value digit and no fake identity', (name) => {
    const { manifest, html } = loadRecording(name);
    for (const page of [manifest.loggedOut, ...manifest.pages]) {
      const { document } = new JSDOM(html(page)).window;
      const values: string[] = [];
      const walker = document.createTreeWalker(document, 4 /* NodeFilter.SHOW_TEXT */);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) values.push(node.nodeValue ?? '');
      for (const el of document.querySelectorAll('*')) for (const attr of el.attributes) if (!STRUCTURAL.test(attr.name)) values.push(attr.value);
      const digits = values.filter((value) => /[1-9]/.test(value.replaceAll(manifest.erpBuild ?? '\0', '')));
      expect(digits, `${name}/${page.file}`).toEqual([]);
      expect(html(page)).not.toContain(ERP_ACCOUNT.displayName);
    }
    expect(readFileSync(new URL(`./testing/recordings/${name}/manifest.json`, import.meta.url), 'utf8')).not.toMatch(/password|BAOX_ERP_TEST/i);
  });
});
