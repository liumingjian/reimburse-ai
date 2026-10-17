// Installing the 本地执行器 (ADR-0035): what it writes so that it starts with the login, per platform, on the Node its
// config records and with a cleared environment; how a zip install rewrites that on its first start; and the copy of
// the unpacked zip into its own directory.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCAL_EXECUTOR_CONFIG_FILE, localExecutorRuntimePath, localExecutorRuntimeSha256Path } from '@baox/contract';
import { afterEach, describe, expect, it } from 'vitest';
import { claimInstance } from './instance';
import { autostartFiles, LAUNCH_AGENT, PROGRAM_FILE, writeInstallFiles, type InstallFile } from './install';
import { CODE_LOADING_ENV, type NodeProbe } from './runtime';
import { prepareStart } from './start';

const dirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'baox-install-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const ORIGIN = 'https://10.250.0.222:8443';

describe('starting with the login on Windows', () => {
  const userHome = 'C:\\Users\\张三';
  const files = autostartFiles({
    platform: 'win32', userHome, appData: 'C:\\Users\\张三\\AppData\\Roaming',
    appDir: 'C:\\Users\\张三\\.baox\\local-executor\\app', logsDir: 'C:\\Users\\张三\\.baox\\local-executor\\logs',
    node: 'C:\\Users\\张三\\AppData\\Roaming\\nvm\\v24.3.0\\node.exe', origin: ORIGIN, runtimePlatform: 'win-x64',
  });
  const runner = files[0]!.content;

  it('puts one script in the Startup folder, one beside the program, and the recorded Node beside it', () => {
    expect(files.map((file) => file.path)).toEqual([
      'C:\\Users\\张三\\.baox\\local-executor\\app\\run-baox.cmd',
      'C:\\Users\\张三\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\baox-local-executor.cmd',
      'C:\\Users\\张三\\.baox\\local-executor\\app\\node-path.txt',
    ]);
  });

  it('writes the scripts in ASCII with CRLF, reaching a Chinese user name through %USERPROFILE%', () => {
    for (const file of files) expect(file.content).toMatch(/^[\x00-\x7f]*$/);
    for (const file of files.slice(0, 2)) expect(file.content.split('\r\n').length).toBeGreaterThan(2);
    expect(files[1]!.content).toContain('%USERPROFILE%\\.baox\\local-executor\\app\\run-baox.cmd');
    expect(files[1]!.content).toContain('-WindowStyle Hidden');
    expect(files[2]!.content).toBe('%USERPROFILE%\\AppData\\Roaming\\nvm\\v24.3.0\\node.exe');
  });

  it('runs the recorded Node, never `node` from PATH, and runs it again after any exit but a clean one', () => {
    expect(runner).toContain('set /p BAOX_NODE=<"%~dp0node-path.txt"');
    expect(runner).toContain(`"%BAOX_NODE%" --use-system-ca "%~dp0${PROGRAM_FILE}" run >> "%USERPROFILE%\\.baox\\local-executor\\logs\\executor.log" 2>&1`);
    expect(runner).not.toMatch(/(^|[\s"(])node(\.exe)? /m);
    expect(runner).toContain('if %errorlevel%==0 exit /b 0');
    expect(runner).toContain('goto loop');
    // A hidden window has no console for `timeout` to wait on.
    expect(runner).toContain('ping -n 11 127.0.0.1 >nul');
    expect(runner).not.toContain('timeout');
  });

  it('falls back to the downloaded runtime, fetching and checking it when it is not there', () => {
    expect(runner).toContain('if not exist "%BAOX_NODE%" set "BAOX_NODE=%~dp0runtime\\node.exe"');
    expect(runner).toContain(`${ORIGIN}${localExecutorRuntimePath('win-x64')}`);
    expect(runner).toContain(`${ORIGIN}${localExecutorRuntimeSha256Path('win-x64')}`);
    expect(runner).toContain('Get-FileHash -Algorithm SHA256');
  });

  it('clears the variables that make Node load extra code before anything runs', () => {
    for (const name of CODE_LOADING_ENV) expect(runner).toContain(`set "${name}="`);
    expect(runner.indexOf('set "NODE_OPTIONS="')).toBeLessThan(runner.indexOf(':loop'));
  });

  it('can be rewritten under the zip-era loop running it: cmd resumes in a line of colons, which it skips', () => {
    // cmd reads a batch file by offset; the zip-era loop resumes after its node line, a few hundred bytes in.
    const [, padding] = runner.split('\r\n');
    expect(padding).toMatch(/^rem :{1000,}$/);
  });
});

describe('starting with the login on macOS', () => {
  const [agent, launcher] = autostartFiles({ platform: 'darwin', userHome: '/Users/zhang', appDir: '/Users/zhang/.baox/local-executor/app', logsDir: '/Users/zhang/.baox/local-executor/logs', node: '/opt/homebrew/bin/node', origin: ORIGIN, runtimePlatform: 'darwin-arm64' });

  it('is a LaunchAgent that starts the launcher beside the program, and again after any exit but a clean one', () => {
    expect(agent!.path).toBe(`/Users/zhang/Library/LaunchAgents/${LAUNCH_AGENT}.plist`);
    expect(agent!.content).toContain('<string>/bin/sh</string>');
    expect(agent!.content).toContain('<string>/Users/zhang/.baox/local-executor/app/run-baox.sh</string>');
    expect(agent!.content).toContain('<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>');
    expect(agent!.content).toContain('<key>RunAtLoad</key><true/>');
    expect(launcher!.path).toBe('/Users/zhang/.baox/local-executor/app/run-baox.sh');
  });

  it('runs the recorded Node, never `node` from PATH', () => {
    expect(launcher!.content).toContain("node='/opt/homebrew/bin/node'");
    expect(launcher!.content).toContain(`exec "$node" --use-system-ca '/Users/zhang/.baox/local-executor/app/${PROGRAM_FILE}' run`);
  });
});

// The LaunchAgent's own command, run as launchd would, over a stub Node that writes down what it was started with.
describe.skipIf(process.platform === 'win32')('the started process', () => {
  const programArguments = (plist: string) => [...plist.split('<key>ProgramArguments</key>')[1]!.split('</array>')[0]!.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]!);
  const stubNode = (path: string, out: string) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, `#!/bin/sh\n{ echo "ARGS $*"; env; } > '${out}'\n`);
    chmodSync(path, 0o755);
  };
  const start = (files: InstallFile[], env: Record<string, string>) => {
    writeInstallFiles(files);
    const [command, ...args] = programArguments(files[0]!.content);
    return spawnSync(command!, args, { env: { PATH: '/usr/bin:/bin', ...env }, encoding: 'utf8' });
  };
  const filesFor = (home: string, node: string) => autostartFiles({ platform: 'darwin', userHome: home, appDir: join(home, 'app'), logsDir: join(home, 'logs'), node, origin: 'http://127.0.0.1:9', runtimePlatform: 'darwin-arm64' });

  it('gets a cleared environment: no NODE_OPTIONS nor any other code-loading variable', () => {
    const home = scratch();
    const out = join(home, 'started.txt');
    const own = join(home, 'own', 'node');
    stubNode(own, out);
    const injected = Object.fromEntries(CODE_LOADING_ENV.map((name) => [name, '/tmp/evil.js']));
    expect(start(filesFor(home, own), { ...injected, HOME: home }).status).toBe(0);
    const seen = readFileSync(out, 'utf8');
    expect(seen).toContain(`ARGS --use-system-ca ${join(home, 'app', PROGRAM_FILE)} run`);
    expect(seen).toContain(`HOME=${home}`);
    for (const name of CODE_LOADING_ENV) expect(seen).not.toContain(`${name}=`);
  });

  it('runs the downloaded runtime when the recorded Node has gone', () => {
    const home = scratch();
    const out = join(home, 'started.txt');
    stubNode(join(home, 'app', 'runtime', 'node'), out);
    expect(start(filesFor(home, join(home, 'gone', 'node')), { HOME: home }).status).toBe(0);
    expect(readFileSync(out, 'utf8')).toContain('ARGS --use-system-ca');
  });
});

describe('a zip install on its first start under this program', () => {
  const zipEra = (home: string) => {
    const appDir = join(home, '.baox', 'local-executor', 'app');
    mkdirSync(join(appDir, 'runtime'), { recursive: true });
    writeFileSync(join(appDir, 'runtime', 'node'), 'the zip runtime');
    writeFileSync(join(appDir, LOCAL_EXECUTOR_CONFIG_FILE), JSON.stringify({ origin: 'http://10.250.0.222:8080', platform: 'darwin-arm64' }));
    const plist = join(home, 'Library', 'LaunchAgents', `${LAUNCH_AGENT}.plist`);
    mkdirSync(join(plist, '..'), { recursive: true });
    writeFileSync(plist, `<plist><dict><key>ProgramArguments</key><array><string>${appDir}/runtime/node</string><string>${appDir}/${PROGRAM_FILE}</string><string>run</string></array></dict></plist>`);
    return { appDir, plist };
  };
  const probe: NodeProbe = { exists: existsSync, version: () => 'v24.21.0', signed: () => true };

  it('rewrites its LaunchAgent to the recorded Node and a cleared environment, and records that Node', async () => {
    const home = scratch();
    const { appDir, plist } = zipEra(home);
    const started = await prepareStart({
      platform: 'darwin', userHome: home, appDir, logsDir: join(home, '.baox', 'local-executor', 'logs'),
      configFile: join(appDir, LOCAL_EXECUTOR_CONFIG_FILE), execPath: join(appDir, 'runtime', 'node'), major: 24, probe,
    });
    expect(started).toEqual({ node: join(appDir, 'runtime', 'node'), restart: false, rewrote: true });
    expect(readFileSync(plist, 'utf8')).toContain(`<string>${appDir}/run-baox.sh</string>`);
    const launcher = readFileSync(join(appDir, 'run-baox.sh'), 'utf8');
    expect(launcher).toContain(`node='${appDir}/runtime/node'`);
    expect(launcher).toContain('unset NODE_OPTIONS');
    expect(JSON.parse(readFileSync(join(appDir, LOCAL_EXECUTOR_CONFIG_FILE), 'utf8'))).toEqual({ origin: 'http://10.250.0.222:8080', platform: 'darwin-arm64', node: join(appDir, 'runtime', 'node') });
  });

  it('rewrites its run-baox.cmd and Startup entry on Windows', async () => {
    // Windows paths do not exist on the machine the tests run on: the config is real, the start entries a map.
    const home = 'C:\\Users\\zhang';
    const appDir = `${home}\\.baox\\local-executor\\app`;
    const config = join(scratch(), LOCAL_EXECUTOR_CONFIG_FILE);
    writeFileSync(config, JSON.stringify({ origin: 'http://10.250.0.222:8080', platform: 'win-x64' }));
    const disk = new Map([[`${appDir}\\run-baox.cmd`, '"%~dp0runtime\\node.exe" "%~dp0baox-local-executor.mjs" run\r\n']]);
    const sync = (files: readonly InstallFile[]) => {
      const changed = files.filter((file) => disk.get(file.path) !== file.content);
      for (const file of changed) disk.set(file.path, file.content);
      return changed.length > 0;
    };
    const started = await prepareStart({
      platform: 'win32', userHome: home, appData: `${home}\\AppData\\Roaming`, appDir, logsDir: `${home}\\.baox\\local-executor\\logs`,
      configFile: config, execPath: `${appDir}\\runtime\\node.exe`, major: 24, probe: { ...probe, exists: () => true }, sync,
    });
    expect(started).toMatchObject({ node: `${appDir}\\runtime\\node.exe`, restart: false, rewrote: true });
    expect(disk.get(`${appDir}\\run-baox.cmd`)).toContain('set "NODE_OPTIONS="');
    expect(disk.get(`${appDir}\\node-path.txt`)).toBe('%USERPROFILE%\\.baox\\local-executor\\app\\runtime\\node.exe');
    expect(disk.get(`${home}\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\baox-local-executor.cmd`)).toContain('run-baox.cmd');
    expect((JSON.parse(readFileSync(config, 'utf8')) as { node: string }).node).toBe(`${appDir}\\runtime\\node.exe`);
  });

  it('leaves the entries alone on the starts after that', async () => {
    const home = scratch();
    const { appDir } = zipEra(home);
    const ports = {
      platform: 'darwin' as const, userHome: home, appDir, logsDir: join(home, 'logs'),
      configFile: join(appDir, LOCAL_EXECUTOR_CONFIG_FILE), execPath: join(appDir, 'runtime', 'node'), major: 24, probe,
    };
    await prepareStart(ports);
    expect(await prepareStart(ports)).toMatchObject({ rewrote: false, restart: false });
  });

  it('asks for a restart onto the downloaded runtime when its own Node no longer qualifies, leaving that Node alone', async () => {
    const home = scratch();
    const { appDir } = zipEra(home);
    const own = join(home, 'own-node');
    writeFileSync(own, 'mine');
    const config = join(appDir, LOCAL_EXECUTOR_CONFIG_FILE);
    writeFileSync(config, JSON.stringify({ origin: 'http://10.250.0.222:8080', platform: 'darwin-arm64', node: own }));
    const started = await prepareStart({
      platform: 'darwin', userHome: home, appDir, logsDir: join(home, 'logs'), configFile: config, execPath: own, major: 24,
      probe: { ...probe, version: (path) => (path === own ? 'v26.0.0' : 'v24.21.0') },
    });
    expect(started).toMatchObject({ node: join(appDir, 'runtime', 'node'), restart: true, rewrote: true });
    expect(readFileSync(own, 'utf8')).toBe('mine');
    expect((JSON.parse(readFileSync(config, 'utf8')) as { node: string }).node).toBe(join(appDir, 'runtime', 'node'));
  });
});

describe('one executor per PC', () => {
  // Clear of 47319, which the maintainer's installed executor holds.
  const port = 46_000 + Math.floor(Math.random() * 900);

  it('lets the first claim the slot, turns a second away while the first lives, and frees it on release', async () => {
    const first = await claimInstance(port);
    expect(first).not.toBeNull();
    expect(await claimInstance(port)).toBeNull();
    first!.release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const again = await claimInstance(port);
    expect(again).not.toBeNull();
    again!.release();
  });
});
