#!/usr/bin/env bash
# The verify skill's launcher. Runs on the Mac through rexec, from the repo (or worktree) root:
#
#   rexec '.claude/skills/verify/verify.sh doctor'                  read-only: is this workspace worth driving?
#   rexec '.claude/skills/verify/verify.sh build'                   web/dist + the e2e server entry
#   rexec '.claude/skills/verify/verify.sh run login-wall'          build, boot a throwaway server, drive, tear down
#   rexec '.claude/skills/verify/verify.sh run login-wall --no-build'
#   rexec '.claude/skills/verify/verify.sh clean'                   stop servers a killed run left behind
#
# Every run boots its own server (server/dist/e2e-main.mjs) on BAOX_PORT=0 and a fresh temp data directory, so runs
# never share state with each other or with the maintainer's QA instance (~/.baox-qa, qa/dev.sh). Evidence goes to
# $BAOX_VERIFY_HOME/<run>/ (default ~/.baox-verify) and its text files are also published under $REXEC_ARTIFACTS.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
SKILL=$ROOT/.claude/skills/verify
EVIDENCE_HOME=${BAOX_VERIFY_HOME:-$HOME/.baox-verify}
ENTRY=$ROOT/server/dist/e2e-main.mjs
CHROME="/Applications/Google Chrome.app"

build() {
  cd "$ROOT"
  pnpm install --frozen-lockfile --prefer-offline --reporter=silent
  # The same build root `pnpm test:e2e` does for the server project: e2e-main.mjs only exists under BAOX_BUILD_E2E=1.
  BAOX_BUILD_E2E=1 pnpm --filter @baox/server --filter @baox/web build >"$EVIDENCE_HOME/last-build.log" 2>&1 || {
    tail -n 40 "$EVIDENCE_HOME/last-build.log" >&2
    exit 1
  }
  echo "built $ENTRY and web/dist"
}

doctor() {
  local bad=0
  check() { if eval "$2" >/dev/null 2>&1; then echo "ok    $1"; else echo "FAIL  $1${3:+ — $3}"; bad=1; fi; }
  # .npmrc's use-node-version gives pnpm scripts their own Node 24; the Mac's bare `node` may be older, so never use it.
  check "pnpm's node is 24 ($(cd "$ROOT" && pnpm exec node --version 2>/dev/null))" '[[ $(cd "$ROOT" && pnpm exec node --version) == v24.* ]]' '.npmrc use-node-version'
  check "pnpm on PATH" 'command -v pnpm'
  check "Google Chrome installed" '[[ -d "$CHROME" ]]' 'drive.mjs launches channel "chrome", like web/playwright.config.ts'
  check "dependencies installed" '[[ -d "$ROOT/node_modules/@playwright/test" ]]' 'verify.sh build installs them'
  check "e2e server entry built" '[[ -f "$ENTRY" && -f "$ROOT/web/dist/index.html" ]]' 'run verify.sh build (or run without --no-build)'
  # rexec's rsync re-stamps every synced file, so mtimes cannot say whether the build is current: rebuild when in doubt.
  local leftover=0 pidfile pid
  for pidfile in "$EVIDENCE_HOME"/*/server.pid; do
    [[ -f $pidfile ]] || continue
    pid=$(cut -d' ' -f1 "$pidfile")
    if kill -0 "$pid" 2>/dev/null; then echo "WARN  verify server still running: pid $pid ($pidfile); verify.sh clean stops it"; leftover=1; fi
  done
  ((leftover)) || echo "ok    no verify server left running"
  return $bad
}

clean() {
  local pidfile pid dataDir
  for pidfile in "$EVIDENCE_HOME"/*/server.pid; do
    [[ -f $pidfile ]] || continue
    read -r pid dataDir <"$pidfile"
    # Only a process that is still our e2e entry on our data directory: a recycled pid is someone else's.
    if kill -0 "$pid" 2>/dev/null && ps -o command= -p "$pid" | grep -q 'e2e-main.mjs'; then
      kill -TERM "$pid" 2>/dev/null || true
      echo "stopped verify server pid $pid"
    fi
    [[ $dataDir == */baox-verify-* ]] && rm -rf "$dataDir"
    rm -f "$pidfile"
  done
  echo "evidence kept in $EVIDENCE_HOME"
}

run() {
  local name=${1:?usage: verify.sh run SCENARIO [--fake MODE] [--no-build]}
  shift
  local doBuild=1 fake=''
  while (($#)); do
    case $1 in
      --no-build) doBuild=0 ;;
      --fake) fake=${2:?--fake needs a mode}; shift ;;
      *) echo "unknown option $1" >&2; exit 64 ;;
    esac
    shift
  done
  local scenario=$SKILL/scenarios/$name.mjs
  [[ -f $scenario ]] || { echo "no scenario $name; have: $(ls "$SKILL/scenarios" | sed 's/\.mjs$//' | tr '\n' ' ')" >&2; exit 64; }
  ((doBuild)) && build
  cd "$ROOT"
  VERIFY_FAKE=$fake pnpm exec node "$SKILL/drive.mjs" "$scenario"
}

mkdir -p "$EVIDENCE_HOME"
case "${1:-}" in
  doctor) doctor ;;
  build) build ;;
  run) shift; run "$@" ;;
  clean) clean ;;
  *) echo "usage: verify.sh doctor|build|run SCENARIO [--fake MODE] [--no-build]|clean" >&2; exit 64 ;;
esac
