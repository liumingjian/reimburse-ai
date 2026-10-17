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
//      already holds this account's pairing, and starts it.
//
// The terminal shows the fixed lines of LOCAL_EXECUTOR_INSTALL_MESSAGES and nothing else: every tool's own output
// goes to ~/.baox/local-executor/logs/install.log, and each failure ends in the one sentence for it.

const sh = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const ps = (value: string) => `'${value.replace(/'/g, "''")}'`;
const LAUNCH_AGENT = 'com.baox.local-executor';

/** A script that prints one sentence and fails, in the shell the system's command pipes into. */
function failingScript(system: InstallSystem, sentence: string): string {
  if (system === 'windows') return `[Console]::Error.WriteLine(${ps(sentence)})\nexit 1\n`;
  return `#!/bin/sh\nprintf '%s\\n' ${sh(sentence)} >&2\nexit 1\n`;
}

/** What the install answers for a code that cannot install: it is past, or it never was. */
export const expiredScript = (system: InstallSystem) => failingScript(system, SAY.expired);

/** What it answers when this server has no program or runtime to install, and for Windows until #426 lands. */
export const unavailableScript = (system: InstallSystem) => failingScript(system, SAY.unavailable);

/** The system an unknown code's error script is written for: `irm` says PowerShell in its User-Agent, curl does not. */
export const systemOfAgent = (userAgent: string | undefined): InstallSystem => (/PowerShell/i.test(userAgent ?? '') ? 'windows' : 'mac');

const MAC_PRELUDE = `#!/bin/sh
set -u
say() { printf '%s\\n' "$1"; }
fail() { printf '%s\\n' "$1" >&2; exit 1; }
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
(umask 077 && mkdir -p "$home" "$logs") && rm -rf "$work" && mkdir -p "$work" || fail ${sh(SAY.disk)}
printf '\\n[%s] install for %s\\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$platform" >>"$log" 2>/dev/null || fail ${sh(SAY.disk)}

# GET $1 into $2; the HTTP status on stdout, nothing when the app did not answer.
get() { curl -sS --connect-timeout 20 -o "$2" -w '%{http_code}' "$origin$1" 2>>"$log"; }
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
  status=$(get "${localExecutorRuntimeSha256Path('$platform')}" "$work/node.sha256") || status=''
  [ -n "$status" ] && [ "$status" != 000 ] || fail ${sh(SAY.unreachable)}
  [ "$status" = 200 ] || fail ${sh(SAY.unavailable)}
  want=$(tr -d ' \\r\\n' <"$work/node.sha256")
  if [ -x "$app/runtime/node" ] && [ "$(sha "$app/runtime/node")" = "$want" ]; then
    node="$app/runtime/node"
  else
    # The download in the background, its progress read off the file as it grows.
    curl -sS --connect-timeout 20 -D "$work/headers" -o "$work/node" "$origin${localExecutorRuntimePath('$platform')}" </dev/null 2>>"$log" &
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
  0) say ${sh(SAY.installed)} ;;
  ${EXIT.expired}) fail ${sh(SAY.expired)} ;;
  ${EXIT.unreachable}) fail ${sh(SAY.unreachable)} ;;
  ${EXIT.start}) fail ${sh(SAY.start)} ;;
  *) fail ${sh(SAY.failed)} ;;
esac
`;
}

/** `/uninstall/mac`: stop it, drop its LaunchAgent and its home. The employee's Node and the pairing in the app stay. */
export function macUninstallScript(): string {
  return `${MAC_PRELUDE}
# baox 本地执行器 uninstall. Run as: curl -fsSL <应用地址>/uninstall/mac | sh
stop
rm -f "$agent" && rm -rf "$home" || fail ${sh(SAY.disk)}
say ${sh(SAY.uninstalled)}
`;
}
