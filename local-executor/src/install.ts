// Installing the 本地执行器 on the employee's PC (ADR-0035). The zip from the settings page is unpacked wherever the
// browser put it; its launcher runs `setup`, which copies the runtime, the program and the config into the executor's
// own directory (`<home>/app`), so that what starts with the login does not depend on the Downloads folder, and
// registers that copy to start with the employee's login:
//
//   Windows  a .cmd in the user's Startup folder that starts `app/run-baox.cmd` with no window; that script runs the
//            program and starts it again 10 s after any exit but a clean one.
//   macOS    a LaunchAgent (~/Library/LaunchAgents) with the same rule (KeepAlive unless the exit was clean).
//
// A clean exit (0) means "nothing to do": not paired any more, or another copy already running. Anything else
// restarts it, which is how a self-update (exit 3, `update.ts`) takes effect. Nothing here needs administrator rights.

import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';
import { LOCAL_EXECUTOR_CONFIG_FILE } from '@baox/contract';

export const PROGRAM_FILE = 'baox-local-executor.mjs';
export const LAUNCH_AGENT = 'com.baox.local-executor';
export const RESTART_EXIT_CODE = 3;

export const runtimeBinary = (platform: string) => (platform === 'win32' ? 'node.exe' : 'node');

export type InstallFile = { path: string; content: string; mode?: number };

// Windows reads a .cmd in the console's code page, so these scripts stay ASCII and reach a path that may hold a
// Chinese user name through %USERPROFILE%, which cmd expands as Unicode.
function windowsPath(path: string, userHome: string): string {
  const rel = win32.relative(userHome, path);
  return rel && !rel.startsWith('..') && /^[\x20-\x7e]*$/.test(rel) ? `%USERPROFILE%\\${rel}` : path;
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The files that make `appDir` start with the login, for `platform`. */
export function autostartFiles({ platform, appDir, logsDir, userHome, appData }: { platform: string; appDir: string; logsDir: string; userHome: string; appData?: string }): InstallFile[] {
  if (platform === 'win32') {
    const runner = win32.join(appDir, 'run-baox.cmd');
    const log = windowsPath(win32.join(logsDir, 'executor.log'), userHome);
    const startup = win32.join(appData ?? win32.join(userHome, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'baox-local-executor.cmd');
    return [
      {
        path: runner,
        content: [
          '@echo off',
          'rem baox local executor: runs the program, and again 10 seconds after any exit but a clean one.',
          'cd /d "%~dp0"',
          ':loop',
          `"%~dp0runtime\\node.exe" "%~dp0${PROGRAM_FILE}" run >> "${log}" 2>&1`,
          'if %errorlevel%==0 exit /b 0',
          'timeout /t 10 /nobreak >nul',
          'goto loop',
          '',
        ].join('\r\n'),
      },
      {
        path: startup,
        content: [
          '@echo off',
          'rem baox local executor: started with the login, with no window.',
          `powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -WindowStyle Hidden -FilePath '${windowsPath(runner, userHome)}'"`,
          '',
        ].join('\r\n'),
      },
    ];
  }
  if (platform === 'darwin') {
    const log = xml(posix.join(logsDir, 'executor.log'));
    return [{
      path: posix.join(userHome, 'Library', 'LaunchAgents', `${LAUNCH_AGENT}.plist`),
      content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCH_AGENT}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(posix.join(appDir, 'runtime', 'node'))}</string>
    <string>${xml(posix.join(appDir, PROGRAM_FILE))}</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`,
    }];
  }
  return [];
}

const sameSize = (a: string, b: string) => existsSync(b) && statSync(a).size === statSync(b).size;

/**
 * Copy the unpacked zip's runtime, program and config into `appDir`. A runtime of the same size is left alone: it is
 * the same Node release, and on Windows a copy that is running cannot be overwritten.
 */
export function installApp({ sourceDir, appDir, platform }: { sourceDir: string; appDir: string; platform: string }): void {
  const binary = runtimeBinary(platform);
  mkdirSync(join(appDir, 'runtime'), { recursive: true });
  const runtime = join(sourceDir, 'runtime', binary);
  const installedRuntime = join(appDir, 'runtime', binary);
  if (!sameSize(runtime, installedRuntime)) {
    copyFileSync(runtime, installedRuntime);
    chmodSync(installedRuntime, 0o755);
  }
  for (const file of [PROGRAM_FILE, LOCAL_EXECUTOR_CONFIG_FILE]) copyFileSync(join(sourceDir, file), join(appDir, file));
}

export function writeInstallFiles(files: readonly InstallFile[]): void {
  for (const file of files) {
    mkdirSync(join(file.path, '..'), { recursive: true });
    writeFileSync(file.path, file.content, { mode: file.mode ?? 0o644 });
  }
}

export function removeInstallFiles(files: readonly InstallFile[]): void {
  for (const file of files) rmSync(file.path, { force: true });
}
