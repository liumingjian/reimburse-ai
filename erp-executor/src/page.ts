// What every executor module shares about a page, whatever carries the commands to it: the page record, its loggable
// URL and the error type, apart from `chromium.ts`'s CDP-over-WebSocket transport.

import type { CdpSession } from './cdp';

export class ExecutorError extends Error {
  constructor(readonly code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

export type ChromiumPage = {
  transport: 'default'; automation?: 'cdp'; browserFamily: 'chromium'; tabId?: string | null; index?: number | null;
  url: string; title?: string | null; active?: boolean; origin?: string | null; pageId?: string; cdpPort?: number;
  cdpTargetId?: string | null; cdpUrl?: string; session?: CdpSession; [extra: string]: unknown;
};

/** Drop the query and hash: K3Cloud's `_cnneptstate_` parameter is session state and must not be logged. */
export const safeUrl = (value: unknown) => {
  try { const parsed = new URL(String(value)); return parsed.origin + parsed.pathname; } catch { return String(value ?? '').split(/[?#]/, 1)[0]!; }
};
