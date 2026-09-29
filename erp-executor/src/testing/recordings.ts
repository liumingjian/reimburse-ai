// Recorded ERP pages (./recordings/<name>/), as `probe <flow> --record <name>` wrote them (recording/cli.ts): a
// manifest, the logged-out login page, and the pages the flow passed through in order. Each page but the last carries
// `data-rec-click` on the element the next click landed on live (in its child frame when `click.frame` says so); the
// fake ERP moves to the next page when a click lands there (or on a wrapper that shows nothing else), and nowhere
// else. Placeholders ({{DISPLAY_NAME}} {{ACCOUNT}} {{TENANT}}) are filled from the fake's account.

import { readdirSync, readFileSync } from 'node:fs';
import type { RecordedPageFacts } from '../recording/redact';

export type RecordedPage = RecordedPageFacts & {
  name: string; file: string;
  /** The child frame on this page (the 发票无忧助手), recorded beside it as `<file>.child.html`. */
  child?: RecordedPageFacts & { file: string };
  /** What the click that left this page landed on, live, and whether it landed in the child frame. */
  click?: { tag: string; id: string; controlId: string; text: string; frame?: 'child' };
};

export type RecordingManifest = {
  flow: string; name: string; description: string; command: string; recordedAt: string; erpBuild: string | null;
  result: Record<string, unknown>; loggedOut: RecordedPage; pages: RecordedPage[];
};

export type Recording = { manifest: RecordingManifest; html(page: { file: string }): string };

const root = new URL('./recordings/', import.meta.url);

/** The names of every committed recording. */
export const recordingNames = () => readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();

export function loadRecording(name: string): Recording {
  const dir = new URL(`${name}/`, root);
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8')) as RecordingManifest;
  return { manifest, html: (page) => readFileSync(new URL(page.file, dir), 'utf8') };
}

type Account = { displayName: string; account: string; tenant: string };

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const fill = (text: string, account: Account, encode: (s: string) => string) =>
  text.replaceAll('{{DISPLAY_NAME}}', encode(account.displayName)).replaceAll('{{ACCOUNT}}', encode(account.account)).replaceAll('{{TENANT}}', encode(account.tenant));

/** A recorded page's HTML with the identity placeholders filled in. */
export const fillIdentity = (html: string, account: Account) => fill(html, account, escapeHtml);

/** `localStorage.k3cloudloginInfo` as recorded, placeholders filled; null when the page had none. */
export function loginInfoOf(page: RecordedPage, account: Account): string | null {
  if (!page.loginInfo) return null;
  return JSON.stringify(Object.fromEntries(Object.entries(page.loginInfo).map(([key, value]) => [key, fill(value, account, (s) => s)])));
}
