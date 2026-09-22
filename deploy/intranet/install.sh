#!/usr/bin/env bash
# Installs baox for first adoption or performs a controlled repair on the phase-1 intranet host. Routine upgrades use
# the maintenance admission lifecycle; this script switches and restarts services directly. Run it as root on the host:
#
#   bash install.sh /tmp/baox-<commit>.tar.gz
#
# The tarball is `git archive` of the commit to deploy; its name, minus .tar.gz, names the release. The walkthrough is
# docs/deployment/intranet-phase-1.md. Everything lands under /opt/tools/baox except the two systemd units.
#
# Idempotent for first adoption and controlled repair: a release already built is not rebuilt, and Node, pnpm and
# Caddy are downloaded once per version. It never writes into the data directory itself. A first install therefore
# starts from an empty database; a controlled repair keeps the one there. Nothing is migrated in and nothing legacy is
# imported.
#
# The first administrator is created here, on the host, before Caddy serves :80 (ADR-0018: the first account created
# becomes the administrator, and on the VPN anyone could otherwise get there before the maintainer). A first install
# therefore needs BAOX_ADMIN_USERNAME, the maintainer's username; the installer prints a temporary password for it,
# which must be changed at the first sign-in.
#
# Overrides, all optional: NODE_MIRROR (default npmmirror, as the repo's .npmrc uses), CADDY_DOWNLOAD (default GitHub
# releases), BAOX_BUILD_PYTHON (an absolute Python 3.8+ executable for node-gyp), npm_config_registry and the usual
# *_proxy variables, all passed through to the build. The native compiler is the isolated GCC named below; see the
# deployment walkthrough for how it is provisioned and verified.
set -euo pipefail

DEPLOY=/opt/tools/baox
CADDY_VERSION=2.10.2
NODE_MIRROR=${NODE_MIRROR:-https://npmmirror.com/mirrors/node}
CADDY_DOWNLOAD=${CADDY_DOWNLOAD:-https://github.com/caddyserver/caddy/releases/download}
KEEP_RELEASES=3
BAOX_PORT=4319
GCC_VERSION=12.5.0
GCC_PREFIX=$DEPLOY/runtime/gcc-$GCC_VERSION
GCC_LIBDIR=$GCC_PREFIX/lib64

log() { printf '==> %s\n' "$*"; }
die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

# Retries a probe for up to 30 seconds.
wait_for() {
  for _ in $(seq 30); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

# --- Preconditions ------------------------------------------------------------------------------------------------

[[ $EUID -eq 0 ]] || die "run as root: it creates the baox user and installs systemd units"
[[ $# -eq 1 ]] || die "usage: install.sh <baox-source.tar.gz>"
tarball=$(readlink -f "$1")
[[ -f $tarball ]] || die "no such tarball: $1"

release_id=$(basename "$tarball")
release_id=${release_id%.tar.gz}
release_id=${release_id%.tgz}
[[ $release_id =~ ^[A-Za-z0-9._-]+$ ]] || die "the tarball name must be letters, digits, '.', '_' or '-': $release_id"

# Only read when the database has no administrator yet. Kept to characters that need no quoting inside JSON.
admin_username=${BAOX_ADMIN_USERNAME:-}
[[ -z $admin_username || $admin_username =~ ^[A-Za-z0-9._@-]{1,32}$ ]] ||
  die "BAOX_ADMIN_USERNAME must be 1-32 letters, digits, '.', '_', '@' or '-': $admin_username"

for cmd in curl tar xz sha256sum sha512sum useradd runuser systemctl getconf readelf; do
  command -v "$cmd" >/dev/null || die "missing command: $cmd"
done
# pnpm compiles better-sqlite3 with node-gyp on every install. Its upstream prebuild needs a newer glibc than this
# host, so this deployment always builds it from source with the isolated C++20 toolchain.
for cmd in make; do
  command -v "$cmd" >/dev/null || die "missing build tool $cmd; install it first: dnf install -y make"
done
build_python=${BAOX_BUILD_PYTHON:-$(command -v python3 || true)}
[[ -n $build_python ]] || die "missing build Python; set BAOX_BUILD_PYTHON to an absolute Python 3.8+ executable"
[[ $build_python == /* && -x $build_python ]] ||
  die "BAOX_BUILD_PYTHON must name an executable absolute path: $build_python"
build_python_version=$(
  "$build_python" -c 'import sys; print(".".join(map(str, sys.version_info[:3])))' 2>/dev/null
) || die "cannot run build Python $build_python"
"$build_python" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 8) else 1)' ||
  die "build Python $build_python is $build_python_version; node-gyp needs Python 3.8 or newer"
for compiler in "$GCC_PREFIX/bin/gcc" "$GCC_PREFIX/bin/g++"; do
  [[ -x $compiler ]] || die "missing isolated GCC $GCC_VERSION compiler: $compiler"
done
[[ -d $GCC_LIBDIR ]] || die "missing isolated GCC $GCC_VERSION runtime library directory: $GCC_LIBDIR"
build_cxx_version=$(LD_LIBRARY_PATH="$GCC_LIBDIR" "$GCC_PREFIX/bin/g++" -dumpfullversion -dumpversion 2>/dev/null) ||
  die "cannot run isolated C++ compiler $GCC_PREFIX/bin/g++"
[[ $(printf '%s\n12.2\n' "$build_cxx_version" | sort -V | head -n1) == 12.2 ]] ||
  die "isolated C++ compiler $GCC_PREFIX/bin/g++ is $build_cxx_version; need GCC 12.2 or newer"

case $(uname -m) in
  x86_64) node_arch=x64 caddy_arch=amd64 ;;
  aarch64) node_arch=arm64 caddy_arch=arm64 ;;
  *) die "unsupported architecture $(uname -m)" ;;
esac

# Node 24's official Linux build needs glibc 2.28 or newer.
glibc=$(getconf GNU_LIBC_VERSION | awk '{print $2}')
[[ $(printf '%s\n2.28\n' "$glibc" | sort -V | head -n1) == 2.28 ]] || die "glibc $glibc is older than the 2.28 Node 24 needs"

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

# --- Service user and directories ---------------------------------------------------------------------------------

if ! id -u baox >/dev/null 2>&1; then
  log "creating system user baox"
  useradd --system --user-group --home-dir "$DEPLOY" --no-create-home --shell /sbin/nologin baox
fi

# Root owns what baox only runs (runtime, proxy binary, config); baox owns what it builds and writes.
install -d -o root -g root -m 0755 "$DEPLOY" "$DEPLOY/bin" "$DEPLOY/runtime" "$DEPLOY/etc"
install -d -o baox -g baox -m 0755 "$DEPLOY/releases" "$DEPLOY/cache" "$DEPLOY/cache/home" "$DEPLOY/caddy"
install -d -o baox -g baox -m 0700 "$DEPLOY/data"
runuser -u baox -- "$build_python" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 8) else 1)' ||
  die "baox cannot execute build Python $build_python"
runuser -u baox -- env LD_LIBRARY_PATH="$GCC_LIBDIR" "$GCC_PREFIX/bin/g++" --version >/dev/null ||
  die "baox cannot execute isolated C++ compiler $GCC_PREFIX/bin/g++"
printf 'int main() { return 0; }\n' | runuser -u baox -- env LD_LIBRARY_PATH="$GCC_LIBDIR" \
  "$GCC_PREFIX/bin/g++" -std=c++20 -x c++ -fsyntax-only - >/dev/null 2>&1 ||
  die "isolated C++ compiler cannot compile a C++20 program as baox"

# --- Release source -----------------------------------------------------------------------------------------------

release=$DEPLOY/releases/$release_id
if [[ ! -f $release/.built ]]; then
  log "unpacking release $release_id"
  rm -rf "$release"
  mkdir -p "$release"
  tar -xzf "$tarball" -C "$release" --no-same-owner
  chown -R baox:baox "$release"
fi
[[ -f $release/.nvmrc && -f $release/package.json ]] || die "$tarball is not a baox source tree (no .nvmrc / package.json at its root)"

# --- Node, pnpm, Caddy: pinned, downloaded once per version -------------------------------------------------------

# The repo pins Node in .nvmrc (package.json engines: >=24 <25); the host's own Node v20 is root's and too old.
node_version=$(tr -d ' v\r\n' <"$release/.nvmrc")
node_name=node-v$node_version-linux-$node_arch
if [[ ! -x $DEPLOY/runtime/$node_name/bin/node ]]; then
  log "downloading Node $node_version"
  curl -fsSL "$NODE_MIRROR/v$node_version/$node_name.tar.xz" -o "$scratch/$node_name.tar.xz"
  curl -fsSL "$NODE_MIRROR/v$node_version/SHASUMS256.txt" -o "$scratch/SHASUMS256.txt"
  (cd "$scratch" && grep " $node_name.tar.xz\$" SHASUMS256.txt | sha256sum -c --quiet -) || die "Node checksum mismatch"
  tar -xJf "$scratch/$node_name.tar.xz" -C "$DEPLOY/runtime" --no-same-owner
fi
ln -sfn "$node_name" "$DEPLOY/runtime/node"

pnpm_version=$(sed -n 's/.*"packageManager": *"pnpm@\([^"]*\)".*/\1/p' "$release/package.json")
[[ -n $pnpm_version ]] || die "package.json names no pnpm version in packageManager"
pnpm_dir=$DEPLOY/runtime/pnpm-$pnpm_version
if [[ ! -x $pnpm_dir/bin/pnpm ]]; then
  log "installing pnpm $pnpm_version"
  PATH=$DEPLOY/runtime/node/bin:$PATH npm install --global --no-fund --no-audit --prefix "$pnpm_dir" "pnpm@$pnpm_version" >/dev/null
fi
# npm creates this root-owned prefix under root's umask. baox executes pnpm during every release build, so it must be
# able to traverse directories and read its executable module; root remains the only writer.
chmod -R a+rX "$pnpm_dir"

caddy_bin=$DEPLOY/bin/caddy-$CADDY_VERSION
if [[ ! -x $caddy_bin ]]; then
  log "downloading Caddy $CADDY_VERSION"
  caddy_tar=caddy_${CADDY_VERSION}_linux_$caddy_arch.tar.gz
  curl -fsSL "$CADDY_DOWNLOAD/v$CADDY_VERSION/$caddy_tar" -o "$scratch/$caddy_tar"
  curl -fsSL "$CADDY_DOWNLOAD/v$CADDY_VERSION/caddy_${CADDY_VERSION}_checksums.txt" -o "$scratch/caddy-checksums.txt"
  (cd "$scratch" && grep " $caddy_tar\$" caddy-checksums.txt | sha512sum -c --quiet -) || die "Caddy checksum mismatch"
  tar -xzf "$scratch/$caddy_tar" -C "$scratch" caddy
  install -o root -g root -m 0755 "$scratch/caddy" "$caddy_bin"
fi
ln -sfn "caddy-$CADDY_VERSION" "$DEPLOY/bin/caddy"

# The server and the root-invoked local wrapper share this credential over the Unix socket. Keep it across releases: a
# changed token would make a newly started server and the installed wrapper disagree during a recovery boundary.
maintenance_token=$DEPLOY/etc/maintenance-gate.token
if [[ ! -e $maintenance_token ]]; then
  log "creating the local maintenance control credential"
  (umask 0077; "$DEPLOY/runtime/node/bin/node" -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('base64url') + '\\n')" >"$maintenance_token")
fi
[[ -f $maintenance_token && ! -L $maintenance_token ]] || die "maintenance control credential is not a regular file: $maintenance_token"
chown root:baox "$maintenance_token"
chmod 0640 "$maintenance_token"
"$DEPLOY/runtime/node/bin/node" -e "const token = require('node:fs').readFileSync(process.argv[1], 'utf8').trim(); process.exit(/^[A-Za-z0-9_-]{32,}$/.test(token) ? 0 : 1)" "$maintenance_token" ||
  die "maintenance control credential is invalid: $maintenance_token"
runuser -u baox -- "$DEPLOY/runtime/node/bin/node" -e "require('node:fs').readFileSync(process.argv[1], 'utf8')" "$maintenance_token" ||
  die "baox cannot read the maintenance control credential: $maintenance_token"

# --- Build, as baox ----------------------------------------------------------------------------------------------

# A clean environment: root's (nvm's PATH, npm prefix) must not leak into the build.
build_env=(
  HOME="$DEPLOY/cache/home"
  PATH="$DEPLOY/runtime/node/bin:$pnpm_dir/bin:/usr/local/bin:/usr/bin:/bin"
  PNPM_HOME="$DEPLOY/cache/pnpm-home"
  npm_config_store_dir="$DEPLOY/cache/pnpm-store"
  npm_config_python="$build_python"
  CC="$GCC_PREFIX/bin/gcc"
  CXX="$GCC_PREFIX/bin/g++"
  LDFLAGS="-Wl,-rpath,$GCC_LIBDIR"
  LD_LIBRARY_PATH="$GCC_LIBDIR"
  LANG=C.UTF-8
)
for var in http_proxy https_proxy no_proxy HTTP_PROXY HTTPS_PROXY NO_PROXY npm_config_registry; do
  if [[ -n ${!var:-} ]]; then build_env+=("$var=${!var}"); fi
done
as_baox() { (cd "$release" && runuser -u baox -- env -i "${build_env[@]}" "$@"); }

if [[ ! -f $release/.built ]]; then
  log "installing dependencies"
  as_baox pnpm install --frozen-lockfile
  better_sqlite3=$(find "$release/node_modules/.pnpm" -path '*/node_modules/better-sqlite3/package.json' -print -quit)
  [[ -n $better_sqlite3 ]] || die "pnpm installed no better-sqlite3 package"
  better_sqlite3=$(dirname "$better_sqlite3")
  node_gyp=$pnpm_dir/lib/node_modules/pnpm/dist/node_modules/node-gyp/bin/node-gyp.js
  [[ -f $node_gyp ]] || die "pnpm bundled no node-gyp executable: $node_gyp"
  log "building better-sqlite3 from source for this host"
  as_baox bash -c 'cd "$1" && exec "$2" "$3" rebuild --force_build=1' _ \
    "$better_sqlite3" "$DEPLOY/runtime/node/bin/node" "$node_gyp"
  binding=$better_sqlite3/build/Release/better_sqlite3.node
  [[ -f $binding ]] || die "node-gyp left no better-sqlite3 binding: $binding"
  prebuild=$better_sqlite3/prebuilds/linux-$node_arch.node
  if [[ -f $prebuild ]]; then mv "$prebuild" "$prebuild.disabled"; fi
  readelf -d "$binding" | grep -Fq "$GCC_LIBDIR" ||
    die "better-sqlite3 binding has no runtime search path for isolated GCC runtime: $GCC_LIBDIR"
  as_baox "$DEPLOY/runtime/node/bin/node" -e '
    const Database = require(process.argv[1]);
    const db = new Database(":memory:");
    db.exec("create table t (n integer); insert into t values (7)");
    if (db.prepare("select n from t").get().n !== 7) process.exit(1);
    db.close();
  ' "$better_sqlite3" || die "better-sqlite3 source binding failed its in-memory database check"
  # Builds web/dist, server/dist (main.mjs, baox.mjs, parse-worker.mjs) and the extension template extension/dist.
  log "building"
  as_baox pnpm build
fi

# The server serves the settings page's extension download from ../../extension/dist relative to server/dist/main.mjs
# (server/src/run.ts). If that is not where the template is, every download answers 503.
main=$release/server/dist/main.mjs
for built in "$main" "$release/server/dist/baox.mjs" "$release/web/dist/index.html" "$(dirname "$main")/../../extension/dist/manifest.json"; do
  [[ -f $built ]] || die "the build left no $built"
done
touch "$release/.built"

# --- Configuration ------------------------------------------------------------------------------------------------

source_dir=$release/deploy/intranet
origin=$(sed -n 's/^Environment=BAOX_PUBLIC_ORIGIN=//p' "$source_dir/baox.service")
# The first site block of the Caddyfile: a line that starts with neither whitespace, '#' nor '{', and opens a block.
site=$(awk '/^[^#[:space:]{].*\{$/ { print $1; exit }' "$source_dir/Caddyfile")
[[ -n $origin && $origin == "$site" ]] || die "BAOX_PUBLIC_ORIGIN ($origin) and the Caddyfile site ($site) must be identical"
legacy_home=$(sed -n 's/^Environment=BAOX_HOME=//p' "$source_dir/baox.service")
[[ -n $legacy_home && ! -e $legacy_home ]] || die "BAOX_HOME ($legacy_home) must name a path that does not exist, so nothing legacy is imported"

runuser -u baox -- env -i HOME="$DEPLOY/cache/home" "$caddy_bin" validate --config "$source_dir/Caddyfile" --adapter caddyfile >/dev/null 2>&1 ||
  die "Caddyfile does not validate: $caddy_bin validate --config $source_dir/Caddyfile --adapter caddyfile"

install -o root -g root -m 0644 "$source_dir/Caddyfile" "$DEPLOY/etc/Caddyfile"
install -o root -g root -m 0755 "$source_dir/baox-maintenance-gate" "$DEPLOY/bin/baox-maintenance-gate"
install -o root -g root -m 0644 "$source_dir/baox.service" /etc/systemd/system/baox.service
install -o root -g root -m 0644 "$source_dir/baox-caddy.service" /etc/systemd/system/baox-caddy.service

if [[ -e $DEPLOY/data/baox.sqlite ]]; then
  log "keeping the existing database in $DEPLOY/data"
else
  log "no database yet: this instance starts from an empty one"
fi

# --- Switch and start ---------------------------------------------------------------------------------------------

ln -sfn "releases/$release_id" "$DEPLOY/current.next"
mv -T "$DEPLOY/current.next" "$DEPLOY/current"

systemctl daemon-reload
systemctl enable baox.service baox-caddy.service >/dev/null
log "restarting baox"
systemctl restart baox.service

# The same Host a browser sends, or the app's guard answers 403.
host=${origin#*://}
session() { curl --noproxy '*' -fsS --max-time 5 -H "Host: $host" "$1/api/session"; }
wait_for session "http://127.0.0.1:$BAOX_PORT" || die "baox does not answer on 127.0.0.1:$BAOX_PORT; see journalctl -u baox"

# --- First administrator, before anyone else can reach the app ---------------------------------------------------

# Only 127.0.0.1:4319 answers until Caddy starts below, and only this host can reach it; the request carries the
# public Host, so it passes the app's exact-origin guard like a browser's. The account is created with a throwaway
# password nobody sees, and the emergency reset (ADR-0018) then gives it a temporary one that must be changed at the
# first sign-in: the password the maintainer ends up with never passes through this script's arguments or history.
if [[ $(session "http://127.0.0.1:$BAOX_PORT") == *'"status":"setup_required"'* ]]; then
  # An earlier run may have got as far as starting Caddy: nothing may serve :80 while there is no administrator.
  systemctl stop baox-caddy.service
  [[ -n $admin_username ]] ||
    die "the database has no administrator yet; rerun with BAOX_ADMIN_USERNAME=<your username> to create it here. Caddy is stopped, so nobody else can create it meanwhile"
  log "creating the first administrator, $admin_username"
  throwaway=$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)
  setup=$(curl --noproxy '*' -sS -o /dev/null --max-time 30 -w '%{http_code}' -H "Host: $host" -H 'content-type: application/json' \
    -d "{\"username\":\"$admin_username\",\"password\":\"$throwaway\"}" "http://127.0.0.1:$BAOX_PORT/api/auth/setup")
  [[ $setup == 200 ]] || die "creating the first administrator answered $setup; see journalctl -u baox"
  # The emergency command is deliberately an offline database writer. Caddy is already stopped above, so taking baox
  # down here creates no public setup window and lets the command take the data-directory lock atomically.
  systemctl stop baox.service
  reset=$(runuser -u baox -- env -i HOME="$DEPLOY/cache/home" BAOX_DATA_DIR="$DEPLOY/data" LANG=C.UTF-8 LD_LIBRARY_PATH="$GCC_LIBDIR" \
    "$DEPLOY/runtime/node/bin/node" "$release/server/dist/baox.mjs" admin emergency-reset "$admin_username") ||
    die "the administrator $admin_username exists but no temporary password was set; run the emergency reset in docs/deployment/intranet-phase-1.md"
  temporary=$(sed -n 's/^临时密码：//p' <<<"$reset")
  [[ -n $temporary ]] || die "the emergency reset printed no temporary password: $reset"
  systemctl start baox.service
  wait_for session "http://127.0.0.1:$BAOX_PORT" || die "baox did not return after first administrator recovery; see journalctl -u baox"
fi

log "restarting Caddy"
systemctl restart baox-caddy.service
wait_for session "http://127.0.0.1" || die "Caddy does not reach baox on :80; see journalctl -u baox-caddy"
upgrade=$(curl --noproxy '*' -s -o /dev/null --max-time 3 -w '%{http_code}' -H "Host: $host" -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' http://127.0.0.1/api/extension/channel || true)
[[ $upgrade == 101 ]] || die "the extension channel upgrade through Caddy answered $upgrade, not 101"

# --- Old releases -------------------------------------------------------------------------------------------------

mapfile -t releases < <(ls -1t "$DEPLOY/releases")
for old in "${releases[@]:$KEEP_RELEASES}"; do
  if [[ $old != "$release_id" ]]; then rm -rf "${DEPLOY:?}/releases/$old"; fi
done

log "baox $release_id is serving $origin: $(session http://127.0.0.1)"
if [[ -n ${temporary:-} ]]; then
  log "first administrator: $admin_username, temporary password: $temporary (change it at the first sign-in)"
fi
