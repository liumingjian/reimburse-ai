import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdaptorServer } from '@hono/node-server';
import {
  EXTENSION_PAIR_PATH, ExtensionPairingSchema, HTTP_ENDPOINTS, LOCAL_EXECUTOR_INSTALL_MESSAGES as SAY, LocalExecutorConfigSchema,
  localExecutorInstallPath, localExecutorUninstallPath,
} from '@baox/contract';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestServer, type TestClient, type TestServer } from '../test/harness';
import type { LocalExecutorDist } from './release';

// The Mac install and uninstall scripts, run for real on a Mac (spec #412 part C): `curl -fsSL <app>/install/<码> | sh`
// against this app on a loopback port, under a temporary HOME, with stub `node`, `codesign` and `launchctl` first on
// PATH. The stub `node` answers `--version` with the version a case asks for and hands anything else to the Node
// running this test, so the real program does the install's last step (start entry, pairing, start). The stub
// `launchctl` only notes what it was asked: the Mac's own LaunchAgent, ~/.baox and port 47319 are never touched.

describe.runIf(process.platform === 'darwin')('the Mac install script, run on a Mac', () => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const SERVED = '24.21.0';
  let workDir: string;
  let dist: LocalExecutorDist;
  let runtimeBytes: Buffer;

  const stubNode = (version: string) => `#!/bin/sh\nif [ "$1" = --version ]; then echo v${version}; exit 0; fi\nexec '${process.execPath}' "$@"\n`;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'baox-install-script-'));
    // The real program, built as the deploy builds it.
    execFileSync(process.execPath, [join(here, '..', '..', '..', 'local-executor', 'scripts', 'build.mjs'), join(workDir, 'dist')], { stdio: 'ignore' });
    dist = { program: join(workDir, 'dist', 'baox-local-executor.mjs'), runtimes: join(workDir, 'runtime') };
    // The served runtime is a stub Node too, padded so the download takes more than one read.
    runtimeBytes = Buffer.from(`${stubNode(SERVED)}#${'x'.repeat(2_000_000)}\n`);
    for (const platform of ['darwin-arm64', 'darwin-x64']) {
      const dir = join(dist.runtimes, SERVED, platform);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'node'), runtimeBytes);
      writeFileSync(join(dir, 'node.sha256'), `${createHash('sha256').update(runtimeBytes).digest('hex')}\n`);
    }
    writeFileSync(join(dist.runtimes, 'VERSION'), `${SERVED}\n`);
  }, 120_000);
  afterAll(() => rmSync(workDir, { recursive: true, force: true }));

  let server: TestServer;
  let http: Server;
  let origin: string;
  let alice: TestClient;
  let home: string;
  let stubs: string;

  beforeEach(async () => {
    server = await createTestServer({ localExecutor: dist });
    http = createAdaptorServer({ fetch: server.app.fetch }) as Server;
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    alice = await server.signIn('alice');
    home = mkdtempSync(join(tmpdir(), 'baox-install-home-'));
    stubs = join(home, 'stub-bin');
    mkdirSync(stubs);
    stub('launchctl', `#!/bin/sh\necho "$*" >> '${join(home, 'launchctl.log')}'\nexit 0\n`);
    return async () => {
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await server.close();
      rmSync(home, { recursive: true, force: true });
    };
  });

  function stub(name: string, content: string) {
    writeFileSync(join(stubs, name), content);
    chmodSync(join(stubs, name), 0o755);
  }
  /** The employee's own Node, as `command -v node` finds it; `signed` is what `codesign` says about it. */
  function ownNode(version: string, signed: boolean) {
    stub('node', stubNode(version));
    stub('codesign', `#!/bin/sh\necho "$*" >> '${join(home, 'codesign.log')}'\nexit ${signed ? 0 : 1}\n`);
  }

  const issue = async () => ExtensionPairingSchema.parse(await (await alice.post(HTTP_ENDPOINTS.createExtensionPairingCode.path, { system: 'mac' })).json()).code!;

  /** What the employee sees in the terminal, line by line, and how it ended. */
  function run(path: string): Promise<{ lines: string[]; status: number | null }> {
    return new Promise((resolve) => {
      const child = spawn('/bin/sh', ['-c', `curl -fsSL '${origin}${path}' | sh`], {
        env: { HOME: home, PATH: `${stubs}:/usr/bin:/bin:/usr/sbin:/sbin`, LANG: 'en_US.UTF-8', NODE_OPTIONS: '--require /nonexistent.js' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
      child.on('close', (status) => resolve({ lines: out.split('\n').filter(Boolean), status }));
    });
  }

  const executorHome = () => join(home, '.baox', 'local-executor');
  const appDir = () => join(executorHome(), 'app');
  const installedConfig = () => LocalExecutorConfigSchema.parse(JSON.parse(readFileSync(join(appDir(), 'baox-config.json'), 'utf8')));
  const agentPlist = () => join(home, 'Library', 'LaunchAgents', 'com.baox.local-executor.plist');
  const launchctl = () => (existsSync(join(home, 'launchctl.log')) ? readFileSync(join(home, 'launchctl.log'), 'utf8').trim().split('\n') : []);
  const installLog = () => {
    const file = join(executorHome(), 'logs', 'install.log');
    return existsSync(file) ? readFileSync(file, 'utf8').slice(-3000) : 'no install log';
  };
  const pairingFile = () => join(executorHome(), 'pairing.json');
  const serverHolder = async () => (await server.db.selectFrom('extension_pairing').select(['holder', 'token_sha256']).where('account_id', '=', alice.account.accountId).executeTakeFirst()) ?? null;
  const DONE = [SAY.checking, SAY.pairing, SAY.installed];
  const DOWNLOAD = /^下载运行环境 (\d+)%$/;

  it('uses the employee own Node when it is the served major version and Node.js signed it, installs, pairs and starts', async () => {
    ownNode('24.9.0', true);
    const code = await issue();
    const { lines, status } = await run(localExecutorInstallPath(code));
    expect(lines, installLog()).toEqual(DONE);
    expect(status).toBe(0);
    expect(installedConfig()).toEqual({ origin, platform: expect.stringMatching(/^darwin-(arm64|x64)$/), node: join(stubs, 'node') });
    expect(existsSync(join(appDir(), 'runtime', 'node'))).toBe(false);
    expect(readFileSync(join(appDir(), 'baox-local-executor.mjs'), 'utf8')).toBe(readFileSync(dist.program, 'utf8'));
    expect(readFileSync(join(home, 'codesign.log'), 'utf8')).toContain('HX7739G8FX');
    // The start entry runs exactly the recorded Node, with the code-loading variables cleared.
    expect(readFileSync(agentPlist(), 'utf8')).toContain(join(appDir(), 'run-baox.sh'));
    const launcher = readFileSync(join(appDir(), 'run-baox.sh'), 'utf8');
    expect(launcher).toContain(`node='${join(stubs, 'node')}'`);
    expect(launcher).toContain('unset NODE_OPTIONS');
    expect(launchctl()).toEqual([expect.stringMatching(/^bootout gui\/\d+\/com\.baox\.local-executor$/), expect.stringMatching(/^bootout /), expect.stringMatching(new RegExp(`^bootstrap gui/\\d+ ${agentPlist()}$`))]);
    expect(JSON.parse(readFileSync(pairingFile(), 'utf8'))).toMatchObject({ origin, accountId: alice.account.accountId });
    expect(await serverHolder()).toMatchObject({ holder: 'local_executor', token_sha256: expect.any(String) });
  }, 60_000);

  it.each([
    ['another major version', '22.12.0', true],
    ['no Node.js signature', '24.9.0', false],
  ])('downloads the served runtime, checked by its sha256, when the employee Node has %s', async (_why, version, signed) => {
    ownNode(version, signed);
    const { lines, status } = await run(localExecutorInstallPath(await issue()));
    expect(status).toBe(0);
    const downloads = lines.filter((line) => DOWNLOAD.test(line));
    expect(downloads.at(-1)).toBe(SAY.downloading(100));
    expect(lines, installLog()).toEqual([SAY.checking, ...downloads, SAY.pairing, SAY.installed]);
    const runtime = join(appDir(), 'runtime', 'node');
    expect(readFileSync(runtime)).toEqual(runtimeBytes);
    expect(installedConfig().node).toBe(runtime);
    expect(readFileSync(join(appDir(), 'run-baox.sh'), 'utf8')).toContain(`node='${runtime}'`);
    // The employee's own Node is left as it was.
    expect(readFileSync(join(stubs, 'node'), 'utf8')).toBe(stubNode(version));
  }, 60_000);

  it('stops an installed 本地执行器 first and overwrites it', async () => {
    ownNode('24.9.0', true);
    mkdirSync(join(appDir(), 'runtime'), { recursive: true });
    writeFileSync(join(appDir(), 'baox-local-executor.mjs'), 'old program\n');
    writeFileSync(join(appDir(), 'baox-config.json'), JSON.stringify({ origin: 'http://10.250.0.222:8888', platform: 'darwin-arm64' }));
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(agentPlist(), 'old agent\n');
    const { lines, status } = await run(localExecutorInstallPath(await issue()));
    expect(lines, installLog()).toEqual(DONE);
    expect(status).toBe(0);
    expect(launchctl()[0]).toMatch(/^bootout gui\/\d+\/com\.baox\.local-executor$/);
    expect(readFileSync(join(appDir(), 'baox-local-executor.mjs'), 'utf8')).toBe(readFileSync(dist.program, 'utf8'));
    expect(installedConfig()).toMatchObject({ origin, node: join(stubs, 'node') });
    expect(readFileSync(agentPlist(), 'utf8')).toContain('<string>com.baox.local-executor</string>');
  }, 60_000);

  it('skips pairing on a second run of the same command after one that paired, and installs again', async () => {
    ownNode('24.9.0', true);
    const code = await issue();
    expect((await run(localExecutorInstallPath(code))).status).toBe(0);
    const paired = readFileSync(pairingFile(), 'utf8');
    // The code is spent now: pairing again would be refused. The second run must not need to.
    const { lines, status } = await run(localExecutorInstallPath(code));
    expect(lines, installLog()).toEqual(DONE);
    expect(status).toBe(0);
    expect(readFileSync(pairingFile(), 'utf8')).toBe(paired);
    expect(launchctl().filter((line) => line.startsWith('bootstrap'))).toHaveLength(2);
  }, 60_000);

  it('ends a failure in one Chinese sentence: an expired code', async () => {
    ownNode('24.9.0', true);
    const { lines, status } = await run(localExecutorInstallPath('NOSUCHCODE'));
    expect(lines, installLog()).toEqual([SAY.expired]);
    expect(status).not.toBe(0);
    expect(existsSync(executorHome())).toBe(false);
  }, 60_000);

  it('ends a failure in one Chinese sentence: a code another holder spent before this PC paired', async () => {
    ownNode('24.9.0', true);
    const code = await issue();
    const spent = await server.app.request(EXTENSION_PAIR_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, version: '9.9.9' }) });
    expect(spent.status).toBe(200);
    const { lines, status } = await run(localExecutorInstallPath(code));
    expect(lines, installLog()).toEqual([SAY.checking, SAY.pairing, SAY.expired]);
    expect(status).not.toBe(0);
  }, 60_000);

  it('ends a failure in one Chinese sentence: no usable Node and no runtime on the server', async () => {
    ownNode('22.12.0', true);
    for (const platform of ['darwin-arm64', 'darwin-x64']) rmSync(join(dist.runtimes, SERVED, platform, 'node.sha256'));
    try {
      const { lines, status } = await run(localExecutorInstallPath(await issue()));
      expect(lines, installLog()).toEqual([SAY.checking, SAY.unavailable]);
      expect(status).not.toBe(0);
    } finally {
      for (const platform of ['darwin-arm64', 'darwin-x64']) writeFileSync(join(dist.runtimes, SERVED, platform, 'node.sha256'), `${createHash('sha256').update(runtimeBytes).digest('hex')}\n`);
    }
  }, 60_000);

  it.each([
    ['its app folder', () => appDir(), [SAY.checking, SAY.disk]],
    ['its log folder', () => join(executorHome(), 'logs'), [SAY.disk]],
  ])('ends a disk failure in %s in one Chinese sentence, with no tool output in the terminal', async (_name, folder, expected) => {
    ownNode('24.9.0', true);
    mkdirSync(folder(), { recursive: true });
    chmodSync(folder(), 0o555);
    try {
      const { lines, status } = await run(localExecutorInstallPath(await issue()));
      expect(lines, installLog()).toEqual(expected);
      expect(status).not.toBe(0);
    } finally {
      chmodSync(folder(), 0o755);
    }
  }, 60_000);

  it('uninstalls with /uninstall/mac: stops it, removes the LaunchAgent and its home, leaves the Node and the pairing in the app', async () => {
    ownNode('24.9.0', true);
    expect((await run(localExecutorInstallPath(await issue()))).status).toBe(0);
    const { lines, status } = await run(localExecutorUninstallPath('mac'));
    expect(lines, installLog()).toEqual([SAY.uninstalled]);
    expect(status).toBe(0);
    expect(launchctl().at(-1)).toMatch(/^bootout gui\/\d+\/com\.baox\.local-executor$/);
    expect(existsSync(agentPlist())).toBe(false);
    expect(existsSync(executorHome())).toBe(false);
    expect(readFileSync(join(stubs, 'node'), 'utf8')).toBe(stubNode('24.9.0'));
    expect(await serverHolder()).toMatchObject({ holder: 'local_executor', token_sha256: expect.any(String) });
  }, 60_000);

  it('is POSIX sh that dash also parses', async () => {
    const code = await issue();
    for (const path of [localExecutorInstallPath(code), localExecutorUninstallPath('mac')]) {
      const file = join(home, 'script.sh');
      writeFileSync(file, await (await server.app.request(path)).text());
      for (const shell of ['/bin/sh', '/bin/dash'].filter(existsSync)) execFileSync(shell, ['-n', file]);
    }
  });
});
