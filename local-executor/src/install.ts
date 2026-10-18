// Installing the 本地执行器 on the employee's PC (ADR-0035). What starts it with the employee's login, per platform:
//
//   Windows  a .cmd in the user's Startup folder that starts `app/run-baox.cmd` with no window; that script runs the
//            program on the Node named in `app/node-path.txt` and starts it again 10 s after any exit but a clean one.
//   macOS    a LaunchAgent (~/Library/LaunchAgents) with the same rule (KeepAlive unless the exit was clean), which
//            runs `app/run-baox.sh` under /bin/sh; that script runs the program on the Node it names.
//
// Both run the Node the executor's config records, by its absolute path and never `node` from PATH, so a Node from nvm
// or Homebrew still starts at login; when that path has gone they fall back to the downloaded runtime (`app/runtime`),
// fetching it and checking its sha256 if it is not there either. Both clear the variables that make Node load extra
// code (`CODE_LOADING_ENV`) before anything runs, and start Node with `--use-system-ca` (ADR-0036). The program
// rechecks the Node at every start and rewrites these files when they differ (`start.ts`), which is how a zip install
// takes this form.
//
// A clean exit (0) means "nothing to do": another copy already running, or stopped on purpose. Anything else
// restarts it, which is how a self-update (exit 3, `update.ts`) takes effect. Nothing here needs administrator rights.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, win32 } from 'node:path';
import { localExecutorRuntimePath, localExecutorRuntimeSha256Path, type LocalExecutorPlatform } from '@baox/contract';
import { CODE_LOADING_ENV, windowsPath } from './runtime';

export const PROGRAM_FILE = 'baox-local-executor.mjs';
export const LAUNCH_AGENT = 'com.baox.local-executor';
export const RESTART_EXIT_CODE = 3;

export const runtimeBinary = (platform: string) => (platform === 'win32' ? 'node.exe' : 'node');
/** Where the runtime downloaded from the app server lives. */
export const downloadedRuntimePath = (appDir: string, platform: string) => (platform === 'win32' ? win32 : posix).join(appDir, 'runtime', runtimeBinary(platform));

export type InstallFile = { path: string; content: string; mode?: number };

export type AutostartPorts = {
  platform: string;
  appDir: string;
  logsDir: string;
  userHome: string;
  appData?: string;
  /** The Node the config records. */
  node: string;
  /** The app, for the runtime download when neither the recorded Node nor the downloaded runtime is there. */
  origin: string;
  runtimePlatform: LocalExecutorPlatform;
};

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const ps = (s: string) => `'${s.replace(/'/g, "''")}'`;

// cmd reads a batch file by byte offset, line by line, and rereads it after each command; a rewrite under a running
// loop (the zip-era run-baox.cmd, a few hundred bytes up to its node line) resumes at the old offset. That lands in
// this line of colons, which cmd reads as a label and skips, and carries on into the new script. The script is then
// never rewritten again: the Node it runs is read from node-path.txt on each round.
const CMD_PADDING = `rem ${':'.repeat(1200)}`;

/** The files that make `appDir` start with the login, for `platform`. */
export function autostartFiles({ platform, appDir, logsDir, userHome, appData, node, origin, runtimePlatform }: AutostartPorts): InstallFile[] {
  const runtimeUrl = `${origin}${localExecutorRuntimePath(runtimePlatform)}`;
  const sumUrl = `${origin}${localExecutorRuntimeSha256Path(runtimePlatform)}`;
  if (platform === 'win32') {
    const runner = win32.join(appDir, 'run-baox.cmd');
    const log = windowsPath(win32.join(logsDir, 'executor.log'), userHome);
    const startup = win32.join(appData ?? win32.join(userHome, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'baox-local-executor.cmd');
    const fetchRuntime = [
      "$ErrorActionPreference='Stop'", "$ProgressPreference='SilentlyContinue'", "$t='%~dp0runtime\\node.exe'", "$p=$t+'.part'",
      'New-Item -ItemType Directory -Force -Path (Split-Path $t) | Out-Null',
      `Invoke-WebRequest -UseBasicParsing -Uri ${ps(runtimeUrl)} -OutFile $p`,
      `$want=([string](Invoke-RestMethod -UseBasicParsing -Uri ${ps(sumUrl)})).Trim()`,
      'if ((Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower() -ne $want) { Remove-Item -LiteralPath $p; exit 1 }',
      'Move-Item -Force -LiteralPath $p -Destination $t',
    ].join('; ');
    return [
      {
        path: runner,
        content: [
          '@echo off',
          CMD_PADDING,
          'rem baox local executor: runs the program on the Node named in node-path.txt, with the variables that make',
          'rem Node load extra code cleared, and again 10 seconds after any exit but a clean one.',
          ...CODE_LOADING_ENV.map((name) => `set "${name}="`),
          'cd /d "%~dp0"',
          ':loop',
          'set "BAOX_NODE="',
          'if exist "%~dp0node-path.txt" set /p BAOX_NODE=<"%~dp0node-path.txt"',
          // node-path.txt is ASCII and may hold %USERPROFILE%: a second expansion resolves it.
          'if defined BAOX_NODE call set "BAOX_NODE=%BAOX_NODE%"',
          'if not exist "%BAOX_NODE%" set "BAOX_NODE=%~dp0runtime\\node.exe"',
          `if not exist "%BAOX_NODE%" powershell -NoProfile -NonInteractive -Command "${fetchRuntime}" >> "${log}" 2>&1`,
          'if not exist "%BAOX_NODE%" goto wait',
          `"%BAOX_NODE%" --use-system-ca "%~dp0${PROGRAM_FILE}" run >> "${log}" 2>&1`,
          'if %errorlevel%==0 exit /b 0',
          ':wait',
          // Not `timeout`: with no console (started hidden) it returns at once and the loop would spin.
          'ping -n 11 127.0.0.1 >nul',
          'goto loop',
          '',
        ].join('\r\n'),
      },
      {
        path: startup,
        content: [
          '@echo off',
          'rem baox local executor: started with the login, with no window.',
          `powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -WindowStyle Hidden -FilePath '${windowsPath(runner, userHome).replace(/'/g, "''")}'"`,
          '',
        ].join('\r\n'),
      },
      // Read by run-baox.cmd in the console's code page: ASCII, reaching a Chinese user name through %USERPROFILE%.
      { path: win32.join(appDir, 'node-path.txt'), content: windowsPath(node, userHome) },
    ];
  }
  if (platform === 'darwin') {
    const launcher = posix.join(appDir, 'run-baox.sh');
    const runtime = posix.join(appDir, 'runtime', 'node');
    const log = xml(posix.join(logsDir, 'executor.log'));
    return [
      {
        path: posix.join(userHome, 'Library', 'LaunchAgents', `${LAUNCH_AGENT}.plist`),
        content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCH_AGENT}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>${xml(launcher)}</string>
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
      },
      {
        path: launcher,
        mode: 0o755,
        content: `#!/bin/sh
# baox local executor, started by its LaunchAgent: the program on the Node its config records, with the variables
# that make Node load extra code cleared. Rewritten by the program when that Node changes.
unset ${CODE_LOADING_ENV.join(' ')}
node=${sh(node)}
if [ ! -x "$node" ]; then
  node=${sh(runtime)}
  if [ ! -x "$node" ]; then
    mkdir -p ${sh(posix.dirname(runtime))}
    # A download that stalls (under 1 KB/s for a minute) ends, so the start fails and launchd starts it again.
    if curl -fsS --connect-timeout 20 --speed-limit 1024 --speed-time 60 -o "$node.part" ${sh(runtimeUrl)} && want=$(curl -fsS --connect-timeout 20 --max-time 60 ${sh(sumUrl)}) && [ "$(shasum -a 256 "$node.part" | cut -d ' ' -f 1)" = "$want" ]; then
      chmod 755 "$node.part" && mv -f "$node.part" "$node"
    else
      rm -f "$node.part"
      echo '[baox] 运行环境没有下载成功，稍后会再试。'
      exit 1
    fi
  fi
fi
exec "$node" --use-system-ca ${sh(posix.join(appDir, PROGRAM_FILE))} run
`,
      },
    ];
  }
  return [];
}

export function writeInstallFiles(files: readonly InstallFile[]): void {
  for (const file of files) {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.content, { mode: file.mode ?? 0o644 });
  }
}

/**
 * Write the files whose content differs from what is there, each through a rename so that a script being read keeps
 * its old copy whole; whether any changed.
 */
export function syncInstallFiles(files: readonly InstallFile[]): boolean {
  let changed = false;
  for (const file of files) {
    if (existsSync(file.path) && readFileSync(file.path, 'utf8') === file.content) continue;
    mkdirSync(dirname(file.path), { recursive: true });
    const next = `${file.path}.next`;
    writeFileSync(next, file.content, { mode: file.mode ?? 0o644 });
    chmodSync(next, file.mode ?? 0o644);
    renameSync(next, file.path);
    changed = true;
  }
  return changed;
}

export function removeInstallFiles(files: readonly InstallFile[]): void {
  for (const file of files) rmSync(file.path, { force: true });
}
