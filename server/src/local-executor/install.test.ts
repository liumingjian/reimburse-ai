import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PAIRING_PATH, PAIRING_CODE_TTL_MS, PairingViewSchema, HTTP_ENDPOINTS, LOCAL_EXECUTOR_INSTALL_MESSAGES,
  localExecutorInstallPath, localExecutorInstallProgramPath, localExecutorUninstallPath,
} from '@baox/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestServer, type TestClient, type TestServer } from '../test/harness';
import { decodedLines } from '../test/powershell';
import type { LocalExecutorDist } from './release';

// The one-command install at the HTTP seam (spec #412 part C): the 设置页 issues a 配对码 with the employee's system,
// and the public `/install/<配对码>` answers the script for that system. Fetching never spends the code; pairing does.
// What the Mac script does on a Mac is `install-script.test.ts`.

let workDir: string;
let server: TestServer;
let alice: TestClient;
const PROGRAM = 'console.log("baox program");\n';

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'baox-install-route-'));
  const dist: LocalExecutorDist = { program: join(workDir, 'baox-local-executor.mjs'), runtimes: join(workDir, 'runtime') };
  writeFileSync(dist.program, PROGRAM);
  mkdirSync(dist.runtimes, { recursive: true });
  writeFileSync(join(dist.runtimes, 'VERSION'), '24.21.0\n');
  server = await createTestServer({ localExecutor: dist });
  alice = await server.signIn('alice');
});
afterEach(async () => {
  await server.close();
  rmSync(workDir, { recursive: true, force: true });
});

const issue = async (body: unknown = { system: 'mac' }) => {
  const answer = await alice.post(HTTP_ENDPOINTS.createPairingCode.path, body);
  expect(answer.status).toBe(200);
  return PairingViewSchema.parse(await answer.json()).code!;
};
const POWERSHELL = { 'user-agent': 'Mozilla/5.0 (Windows NT; Windows NT 10.0; zh-CN) WindowsPowerShell/5.1.19041.1' };
const fetchScript = (code: string, headers: Record<string, string> = { 'user-agent': 'curl/8.7.1' }) => server.app.request(localExecutorInstallPath(code), { headers });
const redeem = (code: string) => server.app.request(PAIRING_PATH, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, version: '9.9.9' }),
});
const expiredScript = (body: string) => {
  expect(body.startsWith('#!/bin/sh\n')).toBe(true);
  expect(body).toContain(LOCAL_EXECUTOR_INSTALL_MESSAGES.expired);
  expect(body).not.toContain('finish-install');
  expect(body).toMatch(/exit 1\n$/);
};

describe('generating a 配对码 for an install', () => {
  it('stores the system chosen with the pending code', async () => {
    await issue({ system: 'windows' });
    const row = await server.db.selectFrom('pairing').selectAll().where('account_id', '=', alice.account.accountId).executeTakeFirstOrThrow();
    expect(row.install_system).toBe('windows');
  });

  it('refuses a system it does not know', async () => {
    const answer = await alice.post(HTTP_ENDPOINTS.createPairingCode.path, { system: 'linux' });
    expect(answer.status).toBe(400);
  });

  it('still issues a code without a system, as re-pairing a running 本地执行器 asks for one, and that code installs nothing', async () => {
    const answer = await alice.request(HTTP_ENDPOINTS.createPairingCode.path, { method: 'POST' });
    expect(answer.status).toBe(200);
    const code = PairingViewSchema.parse(await answer.json()).code!;
    expiredScript(await (await fetchScript(code)).text());
  });
});

describe('the install script route', () => {
  it('answers the Mac shell script for a Mac code, with the app address and the code in it, without a login', async () => {
    const code = await issue();
    const answer = await fetchScript(code);
    expect(answer.status).toBe(200);
    expect(answer.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(answer.headers.get('cache-control')).toBe('no-store');
    const script = await answer.text();
    expect(script.startsWith('#!/bin/sh\n')).toBe(true);
    expect(script).toContain(`'http://localhost'`);
    expect(script).toContain(`'${code}'`);
    expect(script).toContain('com.baox.local-executor');
  });

  it('does not spend the code: fetched twice, it still pairs once, and only once', async () => {
    const code = await issue();
    expect((await fetchScript(code)).status).toBe(200);
    expect((await fetchScript(code)).status).toBe(200);
    expect((await redeem(code)).status).toBe(200);
    expect((await redeem(code)).status).toBe(401);
  });

  it('still answers the script and the program for a code that paired, within its ten minutes', async () => {
    const code = await issue();
    expect((await redeem(code)).status).toBe(200);
    const script = await (await fetchScript(code)).text();
    expect(script).toContain('finish-install');
    expect(script).toContain(`'${alice.account.accountId}'`);
    const program = await server.app.request(localExecutorInstallProgramPath(code));
    expect(program.status).toBe(200);
    expect(await program.text()).toBe(PROGRAM);
  });

  it('answers the Chinese error script, never an HTTP error, for a code that expired, was replaced or never existed', async () => {
    const expired = await issue();
    server.clock.advance(PAIRING_CODE_TTL_MS + 1);
    const replaced = await issue();
    await issue();
    for (const code of [expired, replaced, 'NOSUCHCODE']) {
      const answer = await fetchScript(code);
      expect(answer.status, code).toBe(200);
      expiredScript(await answer.text());
      expect((await server.app.request(localExecutorInstallProgramPath(code))).status, code).toBe(404);
    }
  });

  it('answers the PowerShell script for a Windows code, with the app address, the code and the account in it', async () => {
    const code = await issue({ system: 'windows' });
    const answer = await fetchScript(code, POWERSHELL);
    expect(answer.status).toBe(200);
    expect(answer.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    const script = await answer.text();
    expect(script).not.toContain('#!/bin/sh');
    expect(script).toContain("$origin = 'http://localhost'");
    expect(script).toContain(`$code = '${code}'`);
    expect(script).toContain(`$account = '${alice.account.accountId}'`);
    expect(script).toContain("$major = '24'");
    expect(script).toContain('finish-install');
    expect(script).toContain('win-x64');
  });

  it('answers the PowerShell script for a Windows code whatever fetched it, and the Mac script for a Mac code', async () => {
    const windows = await issue({ system: 'windows' });
    expect(await (await fetchScript(windows)).text()).toContain('finish-install --origin $origin --platform win-x64');
    const mac = await issue({ system: 'mac' });
    expect((await (await fetchScript(mac, POWERSHELL)).text()).startsWith('#!/bin/sh\n')).toBe(true);
  });

  it('answers the PowerShell error script for a Windows code that expired', async () => {
    const code = await issue({ system: 'windows' });
    server.clock.advance(PAIRING_CODE_TTL_MS + 1);
    const script = await (await fetchScript(code, POWERSHELL)).text();
    expect(script).toContain('exit 1');
    expect(script).not.toContain('#!/bin/sh');
    expect(script).not.toContain('finish-install');
    expect(decodedLines(script)).toEqual([LOCAL_EXECUTOR_INSTALL_MESSAGES.expired]);
  });

  it('answers PowerShell its own error script for an unknown code', async () => {
    const answer = await fetchScript('NOSUCHCODE', POWERSHELL);
    const script = await answer.text();
    expect(script).not.toContain('#!/bin/sh');
    expect(script).toMatch(/exit 1/);
    expect(decodedLines(script)).toEqual([LOCAL_EXECUTOR_INSTALL_MESSAGES.expired]);
  });
});

describe('the uninstall script route', () => {
  it('answers the Mac uninstall script without a code or a login', async () => {
    const answer = await server.app.request(localExecutorUninstallPath('mac'));
    expect(answer.status).toBe(200);
    const script = await answer.text();
    expect(script.startsWith('#!/bin/sh\n')).toBe(true);
    expect(script).toContain('launchctl bootout');
    expect(script).toContain(LOCAL_EXECUTOR_INSTALL_MESSAGES.uninstalled);
  });

  it('answers the Windows uninstall script without a code or a login', async () => {
    const answer = await server.app.request(localExecutorUninstallPath('windows'));
    expect(answer.status).toBe(200);
    const script = await answer.text();
    expect(script).not.toContain('#!/bin/sh');
    expect(script).toContain('Stop-Process');
    expect(script).toContain('baox-local-executor.cmd');
    expect(script).not.toContain('finish-install');
    expect(decodedLines(script)).toContain(LOCAL_EXECUTOR_INSTALL_MESSAGES.uninstalled);
  });
});
