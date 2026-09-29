// The named flows `probe <flow> --record <name>` drives through the live ERP. A flow is executor code run on a
// recording session (recorder.ts), so every page it passes through is captured with the element that moved it on.
// A flow stops before any consumption boundary: it opens and reads, it never saves, submits or imports.
//
// Adding a flow (#309): give it the smallest `allowKeys` it needs, name what it ends on in `run`, and list in `mask`
// any part of its pages that shows data rather than UI (other people's work, lists of bills).

import { evalIn } from '../cdp';
import { waitFor, type Pace } from '../pace';
import { COMPATIBILITY_SNIPPET } from '../probe';
import { openNewReimbursement } from '../steps';
import type { MaskRule } from './redact';
import type { RecordingSession } from './recorder';

export type Fingerprint = { erpBuild: string | null; formIds: string[]; activePanels: number };

export type Flow = {
  description: string;
  /** Whether the flow types. The recorder refuses every key otherwise. */
  allowKeys: boolean;
  mask: readonly MaskRule[];
  /**
   * Captions of ERP tabs the recorder closes before and after the flow (as well as every unsaved 新增), so that a
   * recording starts from the same page whatever the last run left open. Without it a 我的费用报销 list tab left
   * over from one run shortens the next run's menu path, and the recording depends on history.
   */
  closeTabs: readonly RegExp[];
  /** Drive the page, then `snapshot` the page the flow ends on. What it returns is written into the manifest. */
  run(page: { session: RecordingSession; pace: Pace }): Promise<Record<string, unknown>>;
};

export const FLOWS: Readonly<Record<string, Flow>> = {
  'new-form': {
    description: 'The logged-in console (login fingerprint), then 我的费用报销 -> 新增 up to an open, empty 费用报销单-新增 whose compatibility fingerprint has settled. Nothing is typed or saved; the 新增单 is discarded with its tab.',
    allowKeys: false,
    mask: [],
    closeTabs: [/^我的费用报销$/],
    async run({ session, pace }) {
      await openNewReimbursement({ session, pace });
      // A fingerprint read the instant the tab opens is a race (probe.ts): wait until exactly one form id answers.
      const fingerprint = await waitFor(() => evalIn<Fingerprint>(session, COMPATIBILITY_SNIPPET), (read) => read?.formIds?.length === 1, 30_000, 500);
      if (fingerprint?.formIds?.length !== 1) throw new Error(`the new form's fingerprint did not settle: ${JSON.stringify(fingerprint)}`);
      await session.snapshot('new-form');
      return { fingerprint };
    },
  },
};
