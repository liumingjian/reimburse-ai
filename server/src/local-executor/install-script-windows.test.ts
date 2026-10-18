import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdaptorServer } from '@hono/node-server';
import {
  PAIRING_CODE_TTL_MS, PairingViewSchema, HTTP_ENDPOINTS, LOCAL_EXECUTOR_INSTALL_EXIT as EXIT, LOCAL_EXECUTOR_INSTALL_MESSAGES as SAY,
  localExecutorInstallPath, localExecutorUninstallPath,
} from '@baox/contract';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestServer, type TestClient, type TestServer } from '../test/harness';
import { decodedLines } from '../test/powershell';
import { expiredScript, windowsInstallScript, windowsUninstallScript } from './install-script';
import type { LocalExecutorDist } from './release';

// The Windows install and uninstall scripts (spec #412 part C, #426). There is no Windows machine in the test setup:
// their text is checked here everywhere, and where PowerShell 7 (`pwsh`) is on PATH they are parsed by PowerShell's
// own parser and run under a temporary profile against this app on a loopback port, with a stub `node.exe` that
// answers `--version` and notes the `finish-install` it is asked for. What only Windows has (Win32_Process, the
// Startup folder taking effect, the program's own start) is the real-machine run before release.

const DOWNLOADING = SAY.downloading(0).slice(0, -2);
const FIXED = new Set<unknown>(Object.values(SAY).filter((value) => typeof value === 'string'));
const scripts = () => ({
  install: windowsInstallScript({ origin: 'https://baox.example.cn', code: 'ABCD2345', accountId: '0b6c1f4e-1111-4222-8333-944455556666', major: 24 }),
  uninstall: windowsUninstallScript(),
  expired: expiredScript('windows'),
});

describe('the Windows scripts, as text', () => {
  it.each(Object.entries(scripts()))('%s is ASCII, so no guess at its encoding by irm on Windows PowerShell 5.1 can garble it', (_name, script) => {
    expect(script).toMatch(/^[\x09\x0a\x0d\x20-\x7e]*$/);
  });

  it.each(Object.entries(scripts()))('%s prints only the fixed Chinese lines', (_name, script) => {
    const lines = decodedLines(script);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(FIXED.has(line) || line === DOWNLOADING, line).toBe(true);
    // Write-Host is the one way out, inside Say and Fail; nothing else writes to the console.
    expect(script.match(/Write-Host/g)?.length).toBe(script === scripts().expired ? 1 : 2);
    expect(script).not.toMatch(/Write-(Output|Error|Warning|Verbose|Information|Progress)|\[Console\]|\becho\b|Out-Host|Out-Default/);
    // Every Say and Fail takes a fixed line, never an error's text.
    for (const call of script.matchAll(/\b(?:Say|Fail) (?!\[string\])(.+)$/gm)) expect(call[1], call[0]).toMatch(/^(\(-join \[char\[\]\]@\([0-9a-fx,]+\)\)|\(\$downloading \+ .+\))( \})?$/);
  });

  it('the install names the platform, clears the code-loading variables and hands the rest to finish-install', () => {
    const { install } = scripts();
    expect(install).toContain("'NODE_OPTIONS'");
    expect(install).toContain('/api/local-executor/runtime/win-x64/sha256');
    expect(install).toContain('/install/ABCD2345/program');
    expect(install).toContain('finish-install --origin $origin --platform win-x64 --node $node --account $account --code $code');
    for (const [name, exit] of Object.entries(EXIT)) expect(install, name).toMatch(new RegExp(`\\b${exit} \\{ Fail `));
  });

  it('the uninstall stops it, removes the Startup entry and its home, and touches nothing of the pairing or the Node', () => {
    const { uninstall } = scripts();
    expect(uninstall).toContain('Stop-Process');
    expect(uninstall).toContain("'baox-local-executor.cmd'");
    expect(uninstall).not.toMatch(/unpair|node\.exe/);
  });
});

// By its absolute path: the runs below give PowerShell a PATH of stubs and the system's own directories.
const pwsh = process.platform === 'win32' ? '' : spawnSync('/bin/sh', ['-c', 'command -v pwsh'], { encoding: 'utf8' }).stdout?.trim() ?? '';

describe.runIf(Boolean(pwsh))('the Windows scripts under PowerShell', () => {
  it.each(Object.entries(scripts()))('%s parses with PowerShell own parser', (name, script) => {
    const dir = mkdtempSync(join(tmpdir(), 'baox-ps-parse-'));
    try {
      const file = join(dir, `${name}.ps1`);
      writeFileSync(file, script);
      const parse = "$e = $null; $t = $null; [void][System.Management.Automation.Language.Parser]::ParseInput([IO.File]::ReadAllText($args[0]), [ref]$t, [ref]$e); $e | ForEach-Object { $_.Message }; exit $e.Count";
      expect(execFileSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', `& { ${parse} } '${file}'`], { encoding: 'utf8' })).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.runIf(Boolean(pwsh))('the Windows scripts run by pwsh under a temporary profile', () => {
  const SERVED = '24.21.0';
  let workDir: string;
  let dist: LocalExecutorDist;
  let runtimeBytes: Buffer;
  const runtimeSha = () => createHash('sha256').update(runtimeBytes).digest('hex');
  const runtimeSumFile = () => join(dist.runtimes, SERVED, 'win-x64', 'node.exe.sha256');
  // A node.exe that answers --version, and otherwise notes its arguments and exits as the case asks.
  const stubNode = (version: string) =>
    `#!/bin/sh\nif [ "$1" = --version ]; then echo v${version}; exit 0; fi\nprintf '%s\\n' "$@" > "$STUB_NOTES"\nexit "\${STUB_EXIT:-0}"\n`;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'baox-ps-install-'));
    dist = { program: join(workDir, 'baox-local-executor.mjs'), runtimes: join(workDir, 'runtime') };
    writeFileSync(dist.program, 'console.log("baox program");\n');
    // The served runtime is a stub node.exe too, padded so the download takes more than one read.
    runtimeBytes = Buffer.from(`${stubNode(SERVED)}#${'x'.repeat(1_500_000)}\n`);
    mkdirSync(join(dist.runtimes, SERVED, 'win-x64'), { recursive: true });
    writeFileSync(join(dist.runtimes, SERVED, 'win-x64', 'node.exe'), runtimeBytes);
    writeFileSync(runtimeSumFile(), `${runtimeSha()}\n`);
    writeFileSync(join(dist.runtimes, 'VERSION'), `${SERVED}\n`);
  });
  afterAll(() => rmSync(workDir, { recursive: true, force: true }));

  let server: TestServer;
  let http: Server;
  let origin: string;
  let alice: TestClient;
  let profile: string;
  let stubs: string;

  beforeEach(async () => {
    server = await createTestServer({ localExecutor: dist });
    http = createAdaptorServer({ fetch: server.app.fetch }) as Server;
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    alice = await server.signIn('alice');
    profile = mkdtempSync(join(tmpdir(), 'baox-ps-profile-'));
    stubs = join(profile, 'stub-bin');
    mkdirSync(stubs);
    return async () => {
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await server.close();
      rmSync(profile, { recursive: true, force: true });
    };
  });

  const notes = () => join(profile, 'finish-install.txt');
  const ownNode = (version: string) => {
    writeFileSync(join(stubs, 'node.exe'), stubNode(version));
    chmodSync(join(stubs, 'node.exe'), 0o755);
  };
  const executorHome = () => join(profile, '.baox', 'local-executor');
  const appDir = () => join(executorHome(), 'app');
  const appData = () => join(profile, 'AppData', 'Roaming');
  const startupEntry = () => join(appData(), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'baox-local-executor.cmd');
  const installLog = () => (existsSync(join(executorHome(), 'logs', 'install.log')) ? readFileSync(join(executorHome(), 'logs', 'install.log'), 'utf8').slice(-3000) : 'no install log');
  const finishArgs = () => readFileSync(notes(), 'utf8').trim().split('\n');
  const issue = async () => PairingViewSchema.parse(await (await alice.post(HTTP_ENDPOINTS.createExtensionPairingCode.path, { system: 'windows' })).json()).code!;

  /** `irm <app><path> | iex` as the command on the 设置页 runs it: what the employee sees, line by line, and the exit. */
  function run(path: string, env: Record<string, string> = {}): Promise<{ lines: string[]; status: number | null }> {
    return new Promise((resolve) => {
      const child = spawn(pwsh, ['-NoProfile', '-NonInteractive', '-Command', `irm '${origin}${path}' | iex`], {
        env: {
          OS: 'Windows_NT', USERPROFILE: profile, HOME: profile, APPDATA: appData(), PATH: `${stubs}:/usr/bin:/bin:/usr/sbin:/sbin`, LANG: 'en_US.UTF-8',
          NODE_OPTIONS: '--require /nonexistent.js', STUB_NOTES: notes(), ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
      child.on('close', (status) => resolve({ lines: out.split(/\r?\n/).filter(Boolean), status }));
    });
  }

  it('uses the employee own Node of the served major version, installs the program and hands it the install', async () => {
    ownNode('24.9.0');
    const code = await issue();
    const { lines, status } = await run(localExecutorInstallPath(code));
    expect(lines, installLog()).toEqual([SAY.checking, SAY.pairing, SAY.installed]);
    expect(status).toBe(0);
    expect(readFileSync(join(appDir(), 'baox-local-executor.mjs'), 'utf8')).toBe(readFileSync(dist.program, 'utf8'));
    expect(existsSync(join(appDir(), 'runtime', 'node.exe'))).toBe(false);
    expect(existsSync(join(executorHome(), 'install.tmp'))).toBe(false);
    expect(finishArgs()).toEqual([
      '--use-system-ca', join(appDir(), 'baox-local-executor.mjs'), 'finish-install', '--origin', origin, '--platform', 'win-x64',
      '--node', join(stubs, 'node.exe'), '--account', alice.account.accountId, '--code', code,
    ]);
  }, 60_000);

  it('downloads the served runtime with its progress, checked by its sha256, when the employee Node is another major version', async () => {
    ownNode('22.12.0');
    const { lines, status } = await run(localExecutorInstallPath(await issue()));
    const downloads = lines.filter((line) => line.startsWith(DOWNLOADING));
    expect(downloads.length, installLog()).toBeGreaterThan(1);
    expect(downloads.at(-1)).toBe(SAY.downloading(100));
    expect(downloads.every((line) => /^下载运行环境 (\d+)%$/.test(line))).toBe(true);
    const runtime = join(appDir(), 'runtime', 'node.exe');
    expect(readFileSync(runtime)).toEqual(runtimeBytes);
    // Windows has no executable bit; here the downloaded file lacks one, so PowerShell refuses to start it, and the
    // run ends in the catch-all sentence. Starting the runtime it downloaded is the next case's, and Windows's.
    expect(lines).toEqual([SAY.checking, ...downloads, SAY.pairing, process.platform === 'win32' ? SAY.installed : SAY.failed]);
    expect(status).toBe(process.platform === 'win32' ? 0 : 1);
  }, 60_000);

  it('keeps an installed runtime that matches the served sha256, and overwrites an old program and config', async () => {
    ownNode('22.12.0');
    mkdirSync(join(appDir(), 'runtime'), { recursive: true });
    writeFileSync(join(appDir(), 'runtime', 'node.exe'), runtimeBytes);
    chmodSync(join(appDir(), 'runtime', 'node.exe'), 0o755);
    writeFileSync(join(appDir(), 'baox-local-executor.mjs'), 'old program\n');
    writeFileSync(join(appDir(), 'baox-config.json'), '{}');
    const { lines, status } = await run(localExecutorInstallPath(await issue()));
    expect(lines, installLog()).toEqual([SAY.checking, SAY.pairing, SAY.installed]);
    expect(status).toBe(0);
    expect(readFileSync(join(appDir(), 'baox-local-executor.mjs'), 'utf8')).toBe(readFileSync(dist.program, 'utf8'));
    expect(existsSync(join(appDir(), 'baox-config.json'))).toBe(false);
    expect(readFileSync(join(appDir(), 'runtime', 'node.exe'))).toEqual(runtimeBytes);
    expect(finishArgs()).toContain(join(appDir(), 'runtime', 'node.exe'));
  }, 60_000);

  it.each([
    [EXIT.expired, SAY.expired],
    [EXIT.unreachable, SAY.unreachable],
    [EXIT.start, SAY.start],
    [1, SAY.failed],
  ])('ends a finish-install exit %s in its one sentence', async (exit, sentence) => {
    ownNode('24.9.0');
    const { lines, status } = await run(localExecutorInstallPath(await issue()), { STUB_EXIT: String(exit) });
    expect(lines, installLog()).toEqual([SAY.checking, SAY.pairing, sentence]);
    expect(status).not.toBe(0);
  }, 60_000);

  it('ends an expired code in its one sentence', async () => {
    ownNode('24.9.0');
    const code = await issue();
    server.clock.advance(PAIRING_CODE_TTL_MS + 1);
    const { lines, status } = await run(localExecutorInstallPath(code));
    expect(lines).toEqual([SAY.expired]);
    expect(status).toBe(1);
    expect(existsSync(executorHome())).toBe(false);
  }, 60_000);

  it('ends no usable Node and no runtime on the server in its one sentence', async () => {
    ownNode('22.12.0');
    rmSync(runtimeSumFile());
    try {
      const { lines, status } = await run(localExecutorInstallPath(await issue()));
      expect(lines, installLog()).toEqual([SAY.checking, SAY.unavailable]);
      expect(status).toBe(1);
    } finally {
      writeFileSync(runtimeSumFile(), `${runtimeSha()}\n`);
    }
  }, 60_000);

  it('ends a run on another system in its one sentence', async () => {
    ownNode('24.9.0');
    const { lines, status } = await run(localExecutorInstallPath(await issue()), { OS: '' });
    expect(lines).toEqual([SAY.wrongSystemWindows]);
    expect(status).toBe(1);
  }, 60_000);

  it('uninstalls with /uninstall/windows: the Startup entry and the home go, the Node stays', async () => {
    ownNode('24.9.0');
    expect((await run(localExecutorInstallPath(await issue()))).status).toBe(0);
    mkdirSync(join(startupEntry(), '..'), { recursive: true });
    writeFileSync(startupEntry(), '@echo off\r\n');
    const { lines, status } = await run(localExecutorUninstallPath('windows'));
    expect(lines).toEqual([SAY.uninstalled]);
    expect(status).toBe(0);
    expect(existsSync(startupEntry())).toBe(false);
    expect(existsSync(executorHome())).toBe(false);
    expect(existsSync(join(stubs, 'node.exe'))).toBe(true);
  }, 60_000);
});
