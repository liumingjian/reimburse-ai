#!/usr/bin/env bash
# The dev-mode QA instance on the maintainer's Mac: the server under `tsx watch` (dev-main.ts) plus the Vite dev
# server, on a data directory that outlives every restart. A pushed web file hot-reloads in the browser; a pushed
# server file restarts only the server; tasks stay in the data directory. The production-build launch is qa/README.md §1.
#
#   qa/dev.sh up       (re)start the instance from this checkout, wait until the page answers through the /api
#                      proxy, print the URL
#   qa/dev.sh sync     push this checkout's changed files into the running instance, print them
#   qa/dev.sh status   print whether it runs, and where
#   qa/dev.sh down     stop it
#
# Agents run it through rexec from the worktree root: `rexec 'qa/dev.sh up'` (blocks until ready), and
# `rexec 'qa/dev.sh sync'` after each fix. The instance runs from its own copy of the tree ($STATE/src, kept by
# qa/mirror.mjs), never from the rexec workspace, and in a process group of its own, so the rexec job ends and frees
# the workspace. `rexec --cancel` cannot reach it for the same reason; only `down` stops it.
#
# Overrides: BAOX_DATA_DIR (default ~/.baox-qa, the same directory the production-build launch uses), BAOX_PORT
# (server, default 4319), BAOX_QA_WEB_PORT (Vite, default 5173), BAOX_QA_DEV_STATE (tree copy, pid file and logs,
# default ~/.baox-qa-dev). Every other BAOX_* variable (BAOX_ERP_CHROMIUM, BAOX_ERP_STOP_BEFORE_IMPORT, ...) passes
# through to the server at `up`. One instance per Mac: `up` stops the previous one first, whichever checkout started it.
#
# Either way 去报销 runs the production path (ADR-0037): it signs in with the account's ERP 凭据 saved on the 设置页
# and ends at 暂存 (ERP 草稿已交接), so save them before the first 去报销. `BAOX_DEV_ERP=cdp` (the default) runs it in
# the dedicated, headed Chromium on this Mac; `BAOX_DEV_ERP=paired qa/dev.sh up` sends it to the paired 本地执行器
# instead (server/src/dev-executors.ts), so a 本地执行器 installed from the 设置页 暂存s in the real ERP.
set -euo pipefail

CHECKOUT=$(cd "$(dirname "$0")/.." && pwd)
STATE=${BAOX_QA_DEV_STATE:-$HOME/.baox-qa-dev}
SRC=$STATE/src
export BAOX_DATA_DIR=${BAOX_DATA_DIR:-$HOME/.baox-qa}
export BAOX_PORT=${BAOX_PORT:-4319}
WEB_PORT=${BAOX_QA_WEB_PORT:-5173}
# Node's runtimes for the 本地执行器 the install command hands out, kept across restarts: the first `up` downloads them.
export BAOX_LOCAL_EXECUTOR_RUNTIMES=${BAOX_LOCAL_EXECUTOR_RUNTIMES:-$STATE/runtimes}
# The key the hosted ERP 凭据 are sealed with. Without one nobody can save 凭据 and no 本地执行器 is sent any; it stays
# across restarts because the 凭据 sealed with it stay in the data directory.
export BAOX_ERP_CREDENTIAL_KEY_FILE=${BAOX_ERP_CREDENTIAL_KEY_FILE:-$STATE/erp-credential-key}
export BAOX_DEV_ERP=${BAOX_DEV_ERP:-cdp}
URL="http://127.0.0.1:$WEB_PORT/"
READY_TIMEOUT_S=180

running_pgid() {
  local pg
  pg=$(cat "$STATE/pgid" 2>/dev/null) || return 1
  [[ $pg =~ ^[0-9]+$ ]] && kill -0 -"$pg" 2>/dev/null && echo "$pg"
}

listener() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1
}

mirror() {
  node "$CHECKOUT/qa/mirror.mjs" "$CHECKOUT" "$SRC"
}

down() {
  local pg
  if pg=$(running_pgid); then
    kill -TERM -"$pg" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 -"$pg" 2>/dev/null || break; sleep 0.5; done
    kill -KILL -"$pg" 2>/dev/null || true
    echo "stopped the dev-mode QA instance (process group $pg)"
  fi
  rm -f "$STATE/pgid"
}

status() {
  local pg
  if pg=$(running_pgid); then
    echo "running: $URL (process group $pg, from $(cat "$STATE/checkout"), data $(cat "$STATE/data"), 去报销 on $(cat "$STATE/dev-erp" 2>/dev/null || echo cdp))"
    echo "logs: $STATE/server.log $STATE/web.log"
  else
    echo "not running"
    return 1
  fi
}

# What `/install/<码>` serves: the program built from this tree and the cached runtimes. Without them the install script
# only says the server has no 本地执行器, so a failed download warns instead of keeping the rest of QA from starting.
executor() {
  echo "building the 本地执行器 program"
  (cd "$SRC" && pnpm --filter @baox/local-executor build >/dev/null)
  echo "fetching its Node runtimes into $BAOX_LOCAL_EXECUTOR_RUNTIMES (skipped when present)"
  # nodejs.org: the Mac reaches it, while the deploy's default (npmmirror) redirects to a CDN it cannot reach.
  NODE_MIRROR=${NODE_MIRROR:-https://nodejs.org/dist} node "$SRC/local-executor/scripts/fetch-runtimes.mjs" "$BAOX_LOCAL_EXECUTOR_RUNTIMES" >/dev/null ||
    echo "warning: no Node runtimes, so the install command will say the server has no 本地执行器" >&2
}

up() {
  down
  local port
  for port in "$BAOX_PORT" "$WEB_PORT"; do
    if [[ -n $(listener "$port") ]]; then
      echo "port $port is taken by pid $(listener "$port"), which this script did not start; stop it first" >&2
      exit 1
    fi
  done

  mkdir -p "$STATE"
  if [[ ! -s $BAOX_ERP_CREDENTIAL_KEY_FILE ]]; then
    (umask 077 && node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' > "$BAOX_ERP_CREDENTIAL_KEY_FILE")
  fi
  echo "$BAOX_DEV_ERP" > "$STATE/dev-erp"
  mirror >/dev/null
  echo "installing dependencies in $SRC (quick when the lockfile is unchanged)"
  (cd "$SRC" && pnpm install --frozen-lockfile --prefer-offline --reporter=silent)
  executor


  : > "$STATE/server.log"
  : > "$STATE/web.log"
  # perl setpgrp: macOS has no setsid(1). The group holds pnpm, tsx watch, the server and Vite, so `down` kills them all.
  cd "$SRC"
  nohup perl -e 'setpgrp(0,0); exec @ARGV or die "exec failed: $!"' -- /bin/bash -c '
    pnpm --filter @baox/server dev >>"$0/server.log" 2>&1 &
    pnpm --filter @baox/web exec vite --host 127.0.0.1 --port "$1" --strictPort >>"$0/web.log" 2>&1 &
    wait' "$STATE" "$WEB_PORT" </dev/null >/dev/null 2>&1 &
  echo $! > "$STATE/pgid"
  echo "$CHECKOUT" > "$STATE/checkout"
  echo "$BAOX_DATA_DIR" > "$STATE/data"

  # /api/session needs no sign-in, so a 200 through Vite's proxy means both servers are up.
  local deadline=$((SECONDS + READY_TIMEOUT_S))
  until curl -fsS -o /dev/null "${URL}api/session" 2>/dev/null; do
    if ((SECONDS >= deadline)) || ! running_pgid >/dev/null; then
      echo "the dev-mode QA instance did not come up within ${READY_TIMEOUT_S}s" >&2
      tail -n 20 "$STATE/server.log" "$STATE/web.log" >&2
      down
      exit 1
    fi
    sleep 1
  done
  echo "dev-mode QA instance ready: $URL"
  echo "data $BAOX_DATA_DIR; logs $STATE/server.log $STATE/web.log"
}

push() {
  if ! running_pgid >/dev/null; then
    echo "the dev-mode QA instance is not running; start it with qa/dev.sh up" >&2
    exit 1
  fi
  local changed
  changed=$(mirror)
  if [[ -z $changed ]]; then
    echo "nothing changed"
    return
  fi
  echo "$changed"
  # A dependency change needs an install, which the running watchers cannot do; the data directory survives the restart.
  if grep -Eq '(^|/| )(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc)$' <<<"$changed"; then
    echo "dependencies changed; restarting the instance"
    BAOX_DEV_ERP=$(cat "$STATE/dev-erp" 2>/dev/null || echo cdp) up
    return
  fi
  # A new program is what an installed executor updates itself to (local-executor/src/update.ts).
  if grep -Eq '(^|/| )(local-executor|channel|erp-executor|extension|contract)/src/' <<<"$changed"; then
    (cd "$SRC" && pnpm --filter @baox/local-executor build >/dev/null)
    echo "rebuilt the 本地执行器 program; an installed one picks it up at its next update check"
  fi
  echo "pushed to $URL (web: hot reload; server: restarts itself, see $STATE/server.log)"
}

case "${1:-}" in
  up) up ;;
  sync) push ;;
  down) down ;;
  status) status ;;
  *) echo "usage: qa/dev.sh up|sync|status|down" >&2; exit 64 ;;
esac
