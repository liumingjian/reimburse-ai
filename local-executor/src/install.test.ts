// Installing the 本地执行器 (ADR-0035): what it writes so that it starts with the login, per platform, and the copy of
// the unpacked zip into its own directory.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claimInstance } from './instance';
import { autostartFiles, installApp, LAUNCH_AGENT, PROGRAM_FILE } from './install';

const dirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'baox-install-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('starting with the login on Windows', () => {
  const userHome = 'C:\\Users\\张三';
  const files = autostartFiles({
    platform: 'win32', userHome, appData: 'C:\\Users\\张三\\AppData\\Roaming',
    appDir: 'C:\\Users\\张三\\.baox\\local-executor\\app', logsDir: 'C:\\Users\\张三\\.baox\\local-executor\\logs',
  });

  it('puts one script in the Startup folder and one beside the program', () => {
    expect(files.map((file) => file.path)).toEqual([
      'C:\\Users\\张三\\.baox\\local-executor\\app\\run-baox.cmd',
      'C:\\Users\\张三\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\baox-local-executor.cmd',
    ]);
  });

  it('writes the scripts in ASCII with CRLF, reaching a Chinese user name through %USERPROFILE%', () => {
    for (const file of files) {
      expect(file.content).toMatch(/^[\x00-\x7f]*$/);
      expect(file.content.split('\r\n').length).toBeGreaterThan(2);
    }
    expect(files[1]!.content).toContain('%USERPROFILE%\\.baox\\local-executor\\app\\run-baox.cmd');
    expect(files[1]!.content).toContain('-WindowStyle Hidden');
  });

  it('runs the program, and runs it again after any exit but a clean one', () => {
    const runner = files[0]!.content;
    expect(runner).toContain(`"%~dp0runtime\\node.exe" "%~dp0${PROGRAM_FILE}" run >> "%USERPROFILE%\\.baox\\local-executor\\logs\\executor.log" 2>&1`);
    expect(runner).toContain('if %errorlevel%==0 exit /b 0');
    expect(runner).toContain('goto loop');
    // A hidden window has no console for `timeout` to wait on.
    expect(runner).toContain('ping -n 11 127.0.0.1 >nul');
    expect(runner).not.toContain('timeout');
  });
});

describe('starting with the login on macOS', () => {
  const [agent] = autostartFiles({ platform: 'darwin', userHome: '/Users/zhang', appDir: '/Users/zhang/.baox/local-executor/app', logsDir: '/Users/zhang/.baox/local-executor/logs' });

  it('is a LaunchAgent that restarts the program after any exit but a clean one', () => {
    expect(agent!.path).toBe(`/Users/zhang/Library/LaunchAgents/${LAUNCH_AGENT}.plist`);
    expect(agent!.content).toContain('<string>/Users/zhang/.baox/local-executor/app/runtime/node</string>');
    expect(agent!.content).toContain(`<string>/Users/zhang/.baox/local-executor/app/${PROGRAM_FILE}</string>`);
    expect(agent!.content).toContain('<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>');
    expect(agent!.content).toContain('<key>RunAtLoad</key><true/>');
  });
});

describe('installApp', () => {
  it('copies the runtime, the program and the config into the executor\'s own directory', () => {
    const source = scratch();
    const app = join(scratch(), 'app');
    mkdirSync(join(source, 'runtime'));
    writeFileSync(join(source, 'runtime', 'node'), 'node');
    writeFileSync(join(source, PROGRAM_FILE), 'program');
    writeFileSync(join(source, 'baox-config.json'), '{}');
    installApp({ sourceDir: source, appDir: app, platform: 'darwin' });
    expect(readFileSync(join(app, 'runtime', 'node'), 'utf8')).toBe('node');
    expect(readFileSync(join(app, PROGRAM_FILE), 'utf8')).toBe('program');
    writeFileSync(join(source, PROGRAM_FILE), 'program 2');
    installApp({ sourceDir: source, appDir: app, platform: 'darwin' });
    expect(readFileSync(join(app, PROGRAM_FILE), 'utf8')).toBe('program 2');
  });
});

describe('one executor per PC', () => {
  const port = 47_000 + Math.floor(Math.random() * 900);

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
