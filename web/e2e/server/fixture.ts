import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, type Page } from '@playwright/test';

// Every server-project test gets its own built server on its own throwaway data directory and a free port, so
// tests never share tasks or accounts. `baseURL` points at it: `page.goto('/#/tasks')`.
const SERVER_ENTRY = fileURLToPath(new URL('../../../server/dist/main.mjs', import.meta.url));
const LISTENING = /listening on (http:\/\/\S+)/;

export type ServerApp = { url: string; dataDir: string };

export const test = base.extend<{ serverApp: ServerApp }>({
  serverApp: async ({}, use) => {
    if (!existsSync(SERVER_ENTRY)) throw new Error(`${SERVER_ENTRY} is missing; run root pnpm test:e2e (it builds the server)`);
    const dataDir = mkdtempSync(join(tmpdir(), 'baox-e2e-'));
    const child = spawn(process.execPath, [SERVER_ENTRY], {
      env: { ...process.env, BAOX_DATA_DIR: dataDir, BAOX_PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const url = await new Promise<string>((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        output += chunk.toString();
        const match = LISTENING.exec(output);
        if (match?.[1]) resolve(match[1]);
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.once('exit', (code) => reject(new Error(`server exited (${code}) before listening:\n${output}`)));
    });
    await use({ url, dataDir });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
    rmSync(dataDir, { recursive: true, force: true });
  },
  baseURL: async ({ serverApp }, use) => use(serverApp.url),
});

export { expect } from '@playwright/test';

export const E2E_PASSWORD = 'e2e-password';

// Signs the page's browser context in without the UI: the first call creates the admin, later calls register users.
// `page.request` shares the context's cookie jar, so the next `page.goto` is already signed in.
export async function signIn(page: Page, username = 'admin'): Promise<void> {
  const session = (await (await page.request.get('/api/session')).json()) as { status: string };
  const path = session.status === 'setup_required' ? '/api/auth/setup' : '/api/auth/register';
  const response = await page.request.post(path, { data: { username, password: E2E_PASSWORD } });
  if (!response.ok()) throw new Error(`signIn(${username}) failed: ${response.status()} ${await response.text()}`);
}
