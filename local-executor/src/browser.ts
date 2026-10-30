// The local executor's browser: a Chromium of its own, one per job, on a persistent profile (ADR-0033).
//
// Persistent because Kingdee's console scripts carry no Cache-Control and are served uncompressed: a profile that
// keeps its HTTP cache logs in within seconds, a fresh one can trip RequireJS's 30 s limit on a slow link (the design's
// S2 result). One job per browser because nothing of a job may outlive it: the run signs out and closes the browser,
// and the next job starts from the ERP entry page.

import type { ErpBrowserMode } from '@baox/contract';
import { createServer } from 'node:net';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from '@baox/erp-executor/cdp';
import { cdpBrowser, ensureChromium } from '@baox/erp-executor/browser';
import type { BrowserPort } from '@baox/erp-executor/job';
import { erpEntryOf } from '@baox/erp-executor/probe';

export type LocalBrowser = { port: number; browser: BrowserPort; close(): Promise<void> };

export type LaunchOptions = { profileDir: string; erpOrigin: string; browserMode?: ErpBrowserMode; env?: Record<string, string | undefined> };

/**
 * Chrome for Testing runs field trials that block the ERP's requests (`ERR_BLOCKED_BY_CLIENT`, measured on the Mac
 * mini); a branded Chrome ignores the flag.
 */
const EXTRA_ARGS = ['--disable-field-trial-config'];

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export async function launchBrowser({ profileDir, erpOrigin, browserMode = 'headless', env = process.env }: LaunchOptions): Promise<LocalBrowser> {
  // A restored session would open last time's tabs next to the ERP entry, and two identical ERP pages are a target
  // the executor refuses to guess between (CHROMIUM_CDP_AMBIGUOUS).
  rmSync(join(profileDir, 'Default', 'Sessions'), { recursive: true, force: true });
  const port = await freePort();
  const { pid } = await ensureChromium({ port, profileDir, openUrl: erpEntryOf(erpOrigin), env, headless: browserMode === 'headless', extraArgs: EXTRA_ARGS });
  return {
    port,
    browser: cdpBrowser(port),
    async close() {
      try {
        const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as { webSocketDebuggerUrl?: string };
        if (version.webSocketDebuggerUrl) {
          const session = await connect(version.webSocketDebuggerUrl, { timeout: 5000 });
          await session.send('Browser.close').catch(() => null);
          session.close();
        }
      } catch { /* already gone, or not answering: the process is ended below */ }
      if (pid === null) return;
      for (let i = 0; i < 50 && alive(pid); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
      if (!alive(pid)) return;
      try {
        if (process.platform === 'win32') process.kill(pid);
        else process.kill(-pid, 'SIGKILL');
      } catch { /* exited meanwhile */ }
    },
  };
}
