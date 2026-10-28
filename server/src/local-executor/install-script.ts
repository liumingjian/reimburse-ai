import {
  CODE_LOADING_ENV, LOCAL_EXECUTOR_INSTALL_EXIT as EXIT, LOCAL_EXECUTOR_INSTALL_MESSAGES as SAY, localExecutorInstallProgramPath,
  localExecutorRuntimePath, localExecutorRuntimeSha256Path, NODE_SIGNATURE_REQUIREMENT, type InstallSystem,
} from '@baox/contract';

// The scripts behind the one-command install (spec #412 part C, ADR-0035 amended 2026-10-17), written per request
// with the app's address and the 配对码 in them. The Mac one is POSIX sh, piped from `curl -fsSL … | sh`:
//
//   1. this Mac's platform (darwin-arm64 / darwin-x64; an Intel shell under Rosetta still finds Apple silicon);
//   2. a Node: the employee's own, when it carries Node.js's own signature (`codesign`, checked before it is run at
//      all) and is the server's major version, else the server's runtime, checked by its sha256 (kept when the copy
//      already installed matches);
//   3. the program, from `/install/<配对码>/program`;
//   4. stop the running 本地执行器 (its LaunchAgent);
//   5. put the program and the runtime into ~/.baox/local-executor/app, overwriting;
//   6-7. the program's own `finish-install` (local-executor/src/main.ts): it records the Node in baox-config.json,
//      writes the LaunchAgent and its launcher exactly as every start does, pairs with the code unless this Mac
//      already holds this account's pairing, and starts it;
//   8. the health check, the program's `await-connected`: 已安装 only once the app sees the started copy's channel.
//
// The terminal shows the fixed lines of LOCAL_EXECUTOR_INSTALL_MESSAGES and nothing else: every tool's own output
// goes to ~/.baox/local-executor/logs/install.log, and each failure ends in the one sentence for it.

const sh = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const ps = (value: string) => `'${value.replace(/'/g, "''")}'`;
const LAUNCH_AGENT = 'com.baox.local-executor';

/**
 * A fixed line as PowerShell builds it from its UTF-16 code units. The Windows scripts stay ASCII this way: `irm` on
 * Windows PowerShell 5.1 decodes the script by a charset it may have to guess, and an ASCII script reads the same under
 * any of them. Write-Host then hands the line to the console as Unicode.
 */
export const powershellText = (line: string) => `(-join [char[]]@(${line.split('').map((unit) => `0x${unit.charCodeAt(0).toString(16).padStart(4, '0')}`).join(',')}))`;
const T = powershellText;
/** A value the app wrote (its address, the code, the account), quoted for PowerShell; built like a fixed line if not ASCII. */
const psValue = (value: string) => (/^[\x20-\x7e]*$/.test(value) ? ps(value) : powershellText(value));

/** A script that prints one sentence and fails, in the shell the system's command pipes into. */
function failingScript(system: InstallSystem, sentence: string): string {
  if (system === 'windows') return `$ProgressPreference = 'SilentlyContinue'\nWrite-Host ${T(sentence)}\nexit 1\n`;
  return `#!/bin/sh\nprintf '%s\\n' ${sh(sentence)} >&2\nexit 1\n`;
}

/** What the install answers for a code that cannot install: it is past, or it never was. */
export const expiredScript = (system: InstallSystem) => failingScript(system, SAY.expired);

/** What it answers when this server has no program or runtime to install. */
export const unavailableScript = (system: InstallSystem) => failingScript(system, SAY.unavailable);

/** The system an unknown code's error script is written for: `irm` says PowerShell in its User-Agent, curl does not. */
export const systemOfAgent = (userAgent: string | undefined): InstallSystem => (/PowerShell/i.test(userAgent ?? '') ? 'windows' : 'mac');

const MAC_PRELUDE = `#!/bin/sh
set -u
# The terminal gets the fixed lines only: the sentence a failure ends in goes to the stderr the script started with
# (fd 3), and every tool's own stderr goes to the install log once it is open (to nowhere before that).
exec 3>&2
say() { printf '%s\\n' "$1"; }
fail() { printf '%s\\n' "$1" >&3; exit 1; }
# Nothing the employee's shell set may make a Node load extra code, or move where the executor lives.
unset ${CODE_LOADING_ENV.join(' ')} BAOX_LOCAL_EXECUTOR_HOME BAOX_LOCAL_EXECUTOR_PORT
[ "$(uname -s 2>/dev/null)" = Darwin ] || fail ${sh(SAY.wrongSystem)}
[ -n "\${HOME:-}" ] || fail ${sh(SAY.disk)}
home="$HOME/.baox/local-executor"
agent="$HOME/Library/LaunchAgents/${LAUNCH_AGENT}.plist"
stop() { launchctl bootout "gui/$(id -u)/${LAUNCH_AGENT}" >/dev/null 2>&1 || true; }
`;

/** The Mac install for one 配对码, written as the app writes codes (its own alphabet: nothing to quote in a URL). */
export function macInstallScript({ origin, code, accountId, major }: { origin: string; code: string; accountId: string; major: number }): string {
  return `${MAC_PRELUDE}
# baox 本地执行器 install for one 配对码, written by the app at ${origin}. Run as: curl -fsSL <应用地址>/install/<配对码> | sh
# The script itself arrives on stdin (curl | sh): what it runs reads /dev/null instead.
origin=${sh(origin)}
code=${sh(code)}
account=${sh(accountId)}
major=${sh(String(major))}
app="$home/app"
logs="$home/logs"
log="$logs/install.log"
work="$home/install.tmp"
fetched=''
cleanup() { [ -n "$fetched" ] && kill "$fetched" >/dev/null 2>&1; rm -rf "$work"; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

# 1. The platform. uname -m says x86_64 in a shell under Rosetta; the hardware still says arm64.
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ] || [ "$(uname -m)" = arm64 ]; then platform=darwin-arm64
elif [ "$(uname -m)" = x86_64 ]; then platform=darwin-x64
else fail ${sh(SAY.wrongSystem)}
fi
exec 2>/dev/null
(umask 077 && mkdir -p "$home" "$logs") && rm -rf "$work" && mkdir -p "$work" || fail ${sh(SAY.disk)}
{ printf '\\n[%s] install for %s\\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$platform" >>"$log"; } 2>/dev/null || fail ${sh(SAY.disk)}
exec 2>>"$log"

# GET $1 into $2 (any more arguments go to curl); the HTTP status on stdout, nothing when the app did not answer. A
# download that stalls (under 1 KB/s for a minute) ends, so the install fails with its sentence instead of hanging.
stall='--speed-limit 1024 --speed-time 60'
get() { path=$1; into=$2; shift 2; curl -sS --connect-timeout 20 $stall "$@" -o "$into" -w '%{http_code}' "$origin$path" 2>>"$log"; }
sha() { shasum -a 256 "$1" 2>>"$log" | cut -d ' ' -f 1; }

say ${sh(SAY.checking)}
# 2. A Node: the employee's own only when Node.js signed it (checked before running it) and it is our major version.
usable() {
  case "$1" in /*) ;; *) return 1 ;; esac
  [ -x "$1" ] || return 1
  codesign --verify --strict -R ${sh(NODE_SIGNATURE_REQUIREMENT)} "$1" >>"$log" 2>&1 || return 1
  version=$("$1" --version </dev/null 2>>"$log") || return 1
  version=\${version#v}
  [ "\${version%%.*}" = "$major" ]
}
node=''
runtime=''
own=$(command -v node 2>/dev/null || true)
if [ -n "$own" ] && usable "$own"; then
  node=$own
else
  status=$(get "${localExecutorRuntimeSha256Path('$platform')}" "$work/node.sha256" --max-time 60) || status=''
  [ -n "$status" ] && [ "$status" != 000 ] || fail ${sh(SAY.unreachable)}
  [ "$status" = 200 ] || fail ${sh(SAY.unavailable)}
  want=$(tr -d ' \\r\\n' <"$work/node.sha256")
  if [ -x "$app/runtime/node" ] && [ "$(sha "$app/runtime/node")" = "$want" ]; then
    node="$app/runtime/node"
  else
    # The download in the background, its progress read off the file as it grows.
    curl -sS --connect-timeout 20 $stall -D "$work/headers" -o "$work/node" "$origin${localExecutorRuntimePath('$platform')}" </dev/null 2>>"$log" &
    fetched=$!
    shown=-1
    show() {
      [ -f "$work/headers" ] && [ -f "$work/node" ] || return 0
      total=$(tr -d '\\r' <"$work/headers" 2>/dev/null | awk 'tolower($1) == "content-length:" { n = $2 } END { print n + 0 }')
      size=$(wc -c <"$work/node" 2>/dev/null | tr -d ' ')
      [ "\${total:-0}" -gt 0 ] && [ -n "$size" ] || return 0
      percent=$((size * 100 / total))
      [ "$percent" -gt 100 ] && percent=100
      percent=$((percent / 10 * 10))
      [ "$percent" -gt "$shown" ] || return 0
      shown=$percent
      say "${SAY.downloading(0).slice(0, -2)}$percent%"
    }
    while kill -0 "$fetched" 2>/dev/null; do show; sleep 1; done
    wait "$fetched"
    ok=$?
    fetched=''
    status=''
    [ -f "$work/headers" ] && status=$(tr -d '\\r' <"$work/headers" | awk 'NR == 1 { print $2 }')
    [ "$ok" = 0 ] || [ -n "$status" ] || fail ${sh(SAY.unreachable)}
    [ "$status" = 200 ] || fail ${sh(SAY.unavailable)}
    [ "$ok" = 0 ] && [ "$(sha "$work/node")" = "$want" ] || fail ${sh(SAY.download)}
    show
    [ "$shown" = 100 ] || say ${sh(SAY.downloading(100))}
    chmod 755 "$work/node" || fail ${sh(SAY.disk)}
    runtime="$work/node"
  fi
fi

# 3. The program, served for this 配对码's ten minutes.
status=$(get "${localExecutorInstallProgramPath('$code')}" "$work/program") || status=''
[ -n "$status" ] && [ "$status" != 000 ] || fail ${sh(SAY.unreachable)}
[ "$status" != 404 ] || fail ${sh(SAY.expired)}
[ "$status" = 200 ] || fail ${sh(SAY.unavailable)}

# 4. Stop the 本地执行器 that runs now, so two never hold this Mac at once.
stop

# 5. Into its home, overwriting what is there.
mkdir -p "$app/runtime" || fail ${sh(SAY.disk)}
if [ -n "$runtime" ]; then
  mv -f "$runtime" "$app/runtime/node" || fail ${sh(SAY.disk)}
  node="$app/runtime/node"
fi
mv -f "$work/program" "$app/baox-local-executor.mjs" || fail ${sh(SAY.disk)}
# The program writes its config anew; an old one is not read on the way.
rm -f "$app/baox-config.json"

# 6-7. Pair and start, by the program itself.
say ${sh(SAY.pairing)}
"$node" --use-system-ca "$app/baox-local-executor.mjs" finish-install --origin "$origin" --platform "$platform" --node "$node" --account "$account" --code "$code" </dev/null >>"$log" 2>&1
case $? in
  0) ;;
  ${EXIT.expired}) fail ${sh(SAY.expired)} ;;
  ${EXIT.unreachable}) fail ${sh(SAY.unreachable)} ;;
  ${EXIT.start}) fail ${sh(SAY.start)} ;;
  *) fail ${sh(SAY.failed)} ;;
esac

# 8. The health check: wait until the app sees the started 本地执行器.
say ${sh(SAY.connecting)}
"$node" --use-system-ca "$app/baox-local-executor.mjs" await-connected </dev/null >>"$log" 2>&1
case $? in
  0) say ${sh(SAY.installed)} ;;
  ${EXIT.notConnected}) fail ${sh(SAY.notConnected)} ;;
  *) fail ${sh(SAY.failed)} ;;
esac
`;
}

/** `/uninstall/mac`: stop it, drop its LaunchAgent and its home. The employee's Node and the pairing in the app stay. */
export function macUninstallScript(): string {
  return `${MAC_PRELUDE}
# baox 本地执行器 uninstall. Run as: curl -fsSL <应用地址>/uninstall/mac | sh
# Its home, log included, is what goes: no tool output is kept.
exec 2>/dev/null
stop
rm -f "$agent" && rm -rf "$home" || fail ${sh(SAY.disk)}
say ${sh(SAY.uninstalled)}
`;
}

// The Windows ones are Windows PowerShell 5.1 (on every Windows 10 and 11), piped from
// `powershell -ExecutionPolicy Bypass -c "irm … | iex"`, in the Mac's steps for win-x64:
//
//   1. Windows, and its profile (USERPROFILE, APPDATA);
//   2. a Node: the employee's own `node.exe` on PATH when it is the server's major version (the version only, no
//      signature: spec #412 story 27a) at a path the ASCII start entry can name, else the server's runtime, checked by
//      its sha256 (kept when the copy already installed matches);
//   3. the program, from `/install/<配对码>/program`;
//   4. stop the running 本地执行器: every process whose command line names its home (run-baox.cmd's loop first, then
//      the program and the browser it drives), a zip install's copy included;
//   5. into %USERPROFILE%\.baox\local-executor\app, overwriting;
//   6-7. the program's own `finish-install`, which writes run-baox.cmd, node-path.txt and the Startup entry exactly as
//      every start does, and pairs unless this PC already holds that account's pairing;
//   8. start it from this session, as the Startup entry does at login (`Start-Baox`): a start from the program's own
//      detached child never ran on a real PC (QA, 2026-10-28), while this Start-Process does;
//   9. the health check, the program's `await-connected`: 已安装 only once the app sees the started copy's channel.
//
// Every line it prints is built from code units (`powershellText`), so the script itself is ASCII. The tools' own
// output goes to the install log; anything unforeseen ends in SAY.failed.

const WINDOWS_PRELUDE = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Say([string]$line) { Write-Host $line }
function Fail([string]$line) { Write-Host $line; exit 1 }
function Under([string]$base) { foreach ($part in $args) { $base = [IO.Path]::Combine($base, $part) }; return $base }
# Nothing the employee's shell set may make a Node load extra code, or move where the executor lives.
foreach ($name in @(${[...CODE_LOADING_ENV, 'BAOX_LOCAL_EXECUTOR_HOME', 'BAOX_LOCAL_EXECUTOR_PORT'].map(ps).join(', ')})) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
if ($env:OS -ne 'Windows_NT') { Fail ${T(SAY.wrongSystemWindows)} }
if (-not $env:USERPROFILE -or -not $env:APPDATA) { Fail ${T(SAY.disk)} }
$baoxHome = Under $env:USERPROFILE '.baox' 'local-executor'
# The Startup entry the program writes (local-executor/src/install.ts), and the one in the Startup folder Windows names.
$startup = @(Under $env:APPDATA 'Microsoft' 'Windows' 'Start Menu' 'Programs' 'Startup' 'baox-local-executor.cmd')
$folder = [Environment]::GetFolderPath('Startup')
if ($folder) { $startup = @($startup + (Under $folder 'baox-local-executor.cmd') | Select-Object -Unique) }
function Stop-Baox {
  if (-not (Get-Command Get-CimInstance -ErrorAction SilentlyContinue)) { return }
  $mark = $baoxHome + [IO.Path]::DirectorySeparatorChar
  $found = @(Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.IndexOf($mark, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
  # run-baox.cmd first: left running, it would start the program again.
  $loops = @($found | Where-Object { $_.Name -eq 'cmd.exe' })
  $rest = @($found | Where-Object { $_.Name -ne 'cmd.exe' })
  foreach ($process in @($loops + $rest)) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }
  foreach ($process in $found) { Wait-Process -Id $process.ProcessId -Timeout 10 -ErrorAction SilentlyContinue }
}
# What the Startup entry runs at login, started now with no window. PowerShell 7 off Windows has no window to hide.
function Start-Baox {
  if ($IsWindows -eq $false) { return }
  Start-Process -WindowStyle Hidden -FilePath (Under $baoxHome 'app' 'run-baox.cmd')
}
`;

/** The Windows install for one 配对码: PowerShell, ASCII, run by `irm <应用地址>/install/<配对码> | iex`. */
export function windowsInstallScript({ origin, code, accountId, major }: { origin: string; code: string; accountId: string; major: number }): string {
  return `${WINDOWS_PRELUDE}${String.raw`
# baox local executor install for one pairing code, written by the app for this PC.
# Run as: powershell -ExecutionPolicy Bypass -c "irm <app>/install/<code> | iex"
$origin = ${psValue(origin)}
$code = ${psValue(code)}
$account = ${psValue(accountId)}
$major = ${ps(String(major))}
$downloading = ${T(SAY.downloading(0).slice(0, -2))}
$app = Under $baoxHome 'app'
$logs = Under $baoxHome 'logs'
$log = Under $logs 'install.log'
$work = Under $baoxHome 'install.tmp'
function Log([string]$line) { try { Add-Content -LiteralPath $log -Value $line -Encoding UTF8 } catch { } }
function Sha([string]$file) { return (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant() }

# GET $path into $file: the HTTP status; 0 when the app did not answer, -1 when the answer was cut off.
function Get-Baox([string]$path, [string]$file, [switch]$progress) {
  try {
    $request = [Net.WebRequest]::Create($origin + $path)
    $request.Timeout = 20000
    $request.ReadWriteTimeout = 60000
    $response = $request.GetResponse()
  } catch {
    $e = $_.Exception
    while ($e -and -not ($e -is [Net.WebException])) { $e = $e.InnerException }
    if ($e -and $e.Response) { return [int]$e.Response.StatusCode }
    Log ($_ | Out-String)
    return 0
  }
  try {
    $total = $response.ContentLength
    $in = $response.GetResponseStream()
    $out = [IO.File]::Create($file)
    $size = 0
    $shown = -1
    try {
      $buffer = New-Object byte[] 65536
      while (($n = $in.Read($buffer, 0, $buffer.Length)) -gt 0) {
        $out.Write($buffer, 0, $n)
        $size += $n
        if ($progress -and $total -gt 0) {
          $percent = [Math]::Min(100, [int][Math]::Floor($size * 10 / $total) * 10)
          if ($percent -gt $shown) { $shown = $percent; Say ($downloading + $percent + '%') }
        }
      }
    } finally {
      $out.Close()
      $in.Close()
    }
    if ($total -gt 0 -and $size -ne $total) { return -1 }
    if ($progress -and $shown -ne 100) { Say ($downloading + '100%') }
    return [int]$response.StatusCode
  } catch {
    Log ($_ | Out-String)
    return -1
  } finally {
    $response.Close()
  }
}

# The employee's own Node: the server's major version, at a path the ASCII start entry can name (%USERPROFILE%\...).
function Test-Node([string]$path) {
  if (-not $path -or -not [IO.Path]::IsPathRooted($path) -or -not (Test-Path -LiteralPath $path -PathType Leaf)) { return $false }
  $rest = $path
  if ($path.StartsWith($env:USERPROFILE + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { $rest = $path.Substring($env:USERPROFILE.Length + 1) }
  if ($rest -notmatch '^[\x20-\x7e]*$') { return $false }
  try {
    $version = & { $ErrorActionPreference = 'Continue'; & $path --version 2>$null | Select-Object -First 1 }
  } catch {
    return $false
  }
  if (-not $version) { return $false }
  return (([string]$version).Trim().TrimStart('v').Split('.')[0] -eq $major)
}

try {
  try {
    New-Item -ItemType Directory -Force -Path $logs | Out-Null
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $work | Out-Null
    Add-Content -LiteralPath $log -Value ('[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] install for win-x64') -Encoding UTF8
  } catch {
    Fail ${T(SAY.disk)}
  }

  Say ${T(SAY.checking)}
  # 2. A Node: the employee's own when it is our major version, else the server's runtime.
  $node = ''
  $runtime = ''
  $own = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($own -and (Test-Node $own.Path)) {
    $node = $own.Path
  } else {
    $sum = Under $work 'node.sha256'
    $status = Get-Baox '${localExecutorRuntimeSha256Path('win-x64')}' $sum
    if ($status -le 0) { Fail ${T(SAY.unreachable)} }
    if ($status -ne 200) { Fail ${T(SAY.unavailable)} }
    $want = (Get-Content -LiteralPath $sum -Raw).Trim()
    $installed = Under $app 'runtime' 'node.exe'
    if ((Test-Path -LiteralPath $installed -PathType Leaf) -and ((Sha $installed) -eq $want)) {
      $node = $installed
    } else {
      $runtime = Under $work 'node.exe'
      $status = Get-Baox '${localExecutorRuntimePath('win-x64')}' $runtime -progress
      if ($status -eq 0) { Fail ${T(SAY.unreachable)} }
      if ($status -eq -1) { Fail ${T(SAY.download)} }
      if ($status -ne 200) { Fail ${T(SAY.unavailable)} }
      if ((Sha $runtime) -ne $want) { Fail ${T(SAY.download)} }
    }
  }

  # 3. The program, served for this pairing code's ten minutes.
  $program = Under $work 'program'
  $status = Get-Baox '${localExecutorInstallProgramPath(code)}' $program
  if ($status -le 0) { Fail ${T(SAY.unreachable)} }
  if ($status -eq 404) { Fail ${T(SAY.expired)} }
  if ($status -ne 200) { Fail ${T(SAY.unavailable)} }

  # 4. Stop the one that runs now, so two never hold this PC at once and its files are free to overwrite.
  Stop-Baox

  # 5. Into its home, overwriting what is there.
  try {
    New-Item -ItemType Directory -Force -Path (Under $app 'runtime') | Out-Null
    if ($runtime) {
      $node = Under $app 'runtime' 'node.exe'
      Move-Item -Force -LiteralPath $runtime -Destination $node
    }
    Move-Item -Force -LiteralPath $program -Destination (Under $app 'baox-local-executor.mjs')
    # The program writes its config anew; an old one is not read on the way.
    $config = Under $app 'baox-config.json'
    if (Test-Path -LiteralPath $config) { Remove-Item -LiteralPath $config -Force }
  } catch {
    Log ($_ | Out-String)
    Fail ${T(SAY.disk)}
  }

  # 6-7. Pair, by the program itself; its output goes to the log.
  Say ${T(SAY.pairing)}
  $global:LASTEXITCODE = 1
  & { $ErrorActionPreference = 'Continue'; & $node --use-system-ca (Under $app 'baox-local-executor.mjs') finish-install --origin $origin --platform win-x64 --node $node --account $account --code $code 2>&1 | ForEach-Object { Log ([string]$_) } }
  switch ($LASTEXITCODE) {
    0 { }
    ${EXIT.expired} { Fail ${T(SAY.expired)} }
    ${EXIT.unreachable} { Fail ${T(SAY.unreachable)} }
    ${EXIT.start} { Fail ${T(SAY.start)} }
    default { Fail ${T(SAY.failed)} }
  }

  # 8. Start it. 9. The health check: wait until the app sees it.
  Say ${T(SAY.connecting)}
  try {
    Start-Baox
  } catch {
    Log ($_ | Out-String)
    Fail ${T(SAY.start)}
  }
  $global:LASTEXITCODE = 1
  & { $ErrorActionPreference = 'Continue'; & $node --use-system-ca (Under $app 'baox-local-executor.mjs') await-connected 2>&1 | ForEach-Object { Log ([string]$_) } }
  switch ($LASTEXITCODE) {
    0 { Say ${T(SAY.installed)} }
    ${EXIT.notConnected} { Fail ${T(SAY.notConnected)} }
    default { Fail ${T(SAY.failed)} }
  }
} catch {
  Log ($_ | Out-String)
  Fail ${T(SAY.failed)}
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
`}`;
}

/** `/uninstall/windows`: stop it, drop its Startup entry and its home. The employee's Node and the pairing in the app stay. */
export function windowsUninstallScript(): string {
  return `${WINDOWS_PRELUDE}${String.raw`
# baox local executor uninstall. Run as: powershell -ExecutionPolicy Bypass -c "irm <app>/uninstall/windows | iex"
try {
  Stop-Baox
  foreach ($entry in $startup) { if (Test-Path -LiteralPath $entry) { Remove-Item -LiteralPath $entry -Force } }
  if (Test-Path -LiteralPath $baoxHome) { Remove-Item -LiteralPath $baoxHome -Recurse -Force }
} catch {
  Fail ${T(SAY.disk)}
}
Say ${T(SAY.uninstalled)}
`}`;
}
