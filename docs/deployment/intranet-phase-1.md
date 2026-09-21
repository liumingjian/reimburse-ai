# Deployment, phase 1: the intranet host

How baox runs on `10.250.0.222` for the browser-extension V1 round (spec #246, ticket #260). The design and its
reasons are in [browser-extension-v1.md](../design/browser-extension-v1.md#deployment-phase-1-intranet-no-domain); this
document is the procedure. The files it installs live in [`deploy/intranet/`](../../deploy/intranet/), and each one
carries its own reasons in comments: [`install.sh`](../../deploy/intranet/install.sh),
[`baox.service`](../../deploy/intranet/baox.service), [`baox-caddy.service`](../../deploy/intranet/baox-caddy.service),
[`Caddyfile`](../../deploy/intranet/Caddyfile).

Every command below is run by the maintainer, from the mac mini or on the host over ssh. The host facts were measured
read-only on 2026-09-21: Kylin Linux Advanced Server V10 (Sword), 8 cores, 14 GiB RAM with 7.1 GiB in use by MySQL, an
Oracle client, Grafana and docker; ports 80 and 443 free; outbound internet working; no caddy, no nginx; Node v20.19.5
only under `/root/.nvm`. Kylin's system glibc is 2.28 and its GCC is 7.3, so the native build runtime below is required.

## Not protected in phase 1

This instance is fit for trying the core flow with made-up data only. Three things are knowingly missing:

- **Traffic is in clear on the LAN.** Plain HTTP: app passwords, 配对码 (pairing code) and 配对凭据 (pairing token),
  session cookies and invoice originals all cross the network readable by anyone on the path between the VPN and the
  host. The ERP itself is plain `http://erp.antute.com.cn`, so this is not below the company's current posture, but it
  is not protection.
- **Invoice originals are unencrypted at rest.** The host has plain LVM on xfs with no dm-crypt anywhere; the data
  directory `/opt/tools/baox/data` sits on it. Anyone with the disk has the originals.
- **There are no backups at all.** Losing the disk or the data directory loses every account, task and original. The
  `backups/` folder inside the data directory is the app's own and lives on the same disk; it is no backup.

These gaps are the phase-1 deviation recorded in
[ADR-0022](../adr/0022-central-invoice-originals-with-full-disk-encryption.md#deployment-deviation-phase-1-2026-09-21),
and its closing condition binds this instance: **the gaps must be closed before the instance holds a real 报销任务
(reimbursement task).** Read ADR-0022 for what closing them means; this document does not restate it.

## Layout

| Path | Owner | What |
|---|---|---|
| `/opt/tools/baox/current` | root (symlink) | The running release, `releases/<name>` |
| `/opt/tools/baox/releases/<name>/` | baox | One built source tree per deployed tarball; the last 3 are kept |
| `/opt/tools/baox/data/` | baox, 0700 | `BAOX_DATA_DIR`: `baox.sqlite` and the invoice originals |
| `/opt/tools/baox/runtime/node` | root | Node at the version in `.nvmrc`, for baox only |
| `/opt/tools/baox/runtime/pnpm-<version>/` | root | pnpm at the version in `package.json` `packageManager`, for the build |
| `/opt/tools/baox/runtime/gcc-12.5.0/` | root | Isolated C++20 compiler and runtime used only by baox |
| `/opt/tools/baox/bin/caddy` | root | Caddy, one static binary, version pinned in `install.sh` |
| `/opt/tools/baox/etc/Caddyfile` | root | Installed from `deploy/intranet/Caddyfile` |
| `/opt/tools/baox/cache/` | baox | pnpm store and the build's home directory |
| `/home/baox/.local/` | baox | Private uv, managed Python, and the build virtual environment |
| `/etc/systemd/system/baox.service`, `baox-caddy.service` | root | The two units |

## Native build runtime

The deployment does not replace Kylin's compiler, loader, `libstdc++`, or `libgcc`. Create `/home/baox` as `baox:baox`
with mode `0750`; its `.bashrc` is mode `0640` and contains the host proxy exports plus
`export PATH="/home/baox/.local/bin:$PATH"`. Because the account has a nologin shell, every noninteractive command uses
an explicit clean environment instead of relying on `.bashrc`.

On a fresh host, create that account and its private build home before running `install.sh`:

```bash
if ! id -u baox >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /home/baox --create-home --shell /sbin/nologin baox
fi
install -d -o baox -g baox -m 0750 /home/baox /home/baox/.local /home/baox/.local/bin /home/baox/.cache
test -e /home/baox/.bashrc || install -o baox -g baox -m 0640 /dev/null /home/baox/.bashrc
printf '%s\n' 'export HTTP_PROXY="http://192.168.2.201:7890"' 'export HTTPS_PROXY="http://192.168.2.201:7890"' \
  'export PATH="/home/baox/.local/bin:$PATH"' >> /home/baox/.bashrc
chown baox:baox /home/baox/.bashrc
chmod 0640 /home/baox/.bashrc
```

Install uv in `/home/baox/.local/bin`, then provision the Python node-gyp uses:

```bash
proxy=http://192.168.2.201:7890
cd /home/baox
runuser -u baox -- env -i HOME=/home/baox PATH=/home/baox/.local/bin:/usr/local/bin:/usr/bin:/bin \
  HTTP_PROXY="$proxy" HTTPS_PROXY="$proxy" UV_CACHE_DIR=/home/baox/.cache/uv \
  UV_PYTHON_INSTALL_DIR=/home/baox/.local/share/uv/python \
  uv python install 3.12
runuser -u baox -- env -i HOME=/home/baox PATH=/home/baox/.local/bin:/usr/local/bin:/usr/bin:/bin \
  HTTP_PROXY="$proxy" HTTPS_PROXY="$proxy" UV_CACHE_DIR=/home/baox/.cache/uv \
  UV_PYTHON_INSTALL_DIR=/home/baox/.local/share/uv/python \
  uv venv --python 3.12 /home/baox/.local/share/baox-build-venv
```

Use GNU GCC 12.5.0, built under `/opt/tools/baox/runtime/gcc-12.5.0` with `--disable-bootstrap`, only C and C++,
`--disable-multilib`, and `make -j2`. Verify `gcc-12.5.0.tar.xz` with its GNU signature and this official SHA-512 before
extracting it:

```text
c76020e4c844b53485502cb8a4e295221c9d37487d66c9f4559031fb14c85de20602e6387310005386cb0ef25e55067d2cfef141423bb445f3b77e7456a23533
```

The source signature is `gcc-12.5.0.tar.xz.sig` from
`https://gcc.gnu.org/pub/gcc/releases/gcc-12.5.0/`; verify it with GNU's `gnu-keyring.gpg` using `gpgv`. Install only
the `gmp-devel`, `mpfr-devel`, `libmpc-devel`, and `isl-devel` build inputs after reviewing the dnf transaction; do not
upgrade or replace GCC, glibc, `libstdc++`, or `libgcc`. When the host cannot fetch a release asset, transfer a
locally signature-verified copy and repeat the host-side `gpgv` and SHA-512 checks.

With the verified tarball, signature, and keyring under `/opt/tools/baox/runtime/src/gcc-12.5.0/`, build as root:

```bash
runtime=/opt/tools/baox/runtime
source_dir=$runtime/src/gcc-12.5.0
source_tree=$source_dir/gcc-12.5.0
build_dir=$runtime/build/gcc-12.5.0
prefix=$runtime/gcc-12.5.0

gpgv --keyring "$source_dir/gnu-keyring.gpg" "$source_dir/gcc-12.5.0.tar.xz.sig" "$source_dir/gcc-12.5.0.tar.xz"
printf '%s  %s\n' \
  c76020e4c844b53485502cb8a4e295221c9d37487d66c9f4559031fb14c85de20602e6387310005386cb0ef25e55067d2cfef141423bb445f3b77e7456a23533 \
  "$source_dir/gcc-12.5.0.tar.xz" | sha512sum -c --strict
tar -xJf "$source_dir/gcc-12.5.0.tar.xz" -C "$source_dir"
mkdir -p "$build_dir"
cd "$build_dir"
MAKEINFO=true "$source_tree/configure" --prefix="$prefix" --disable-bootstrap \
  --enable-languages=c,c++ --disable-multilib --disable-nls --disable-libsanitizer \
  --with-gmp=/usr --with-mpfr=/usr --with-mpc=/usr --with-isl=/usr
make -j2
make install
chown -R root:root "$prefix"
chmod -R a+rX "$prefix"
LD_LIBRARY_PATH="$prefix/lib64" "$prefix/bin/g++" -dumpfullversion -dumpversion
printf 'int main() { return 0; }\n' | runuser -u baox -- \
  env LD_LIBRARY_PATH="$prefix/lib64" "$prefix/bin/g++" -std=c++20 -x c++ -fsyntax-only -
```

`install.sh` compiles `better-sqlite3` from source with this compiler, embeds a runtime search path to its `lib64`, and moves only
that release's incompatible upstream prebuild aside. `baox.service` also sets the same `LD_LIBRARY_PATH` for baox alone;
there is no host-wide loader configuration or `ldconfig` change. `make install` follows root's umask, so the explicit
ownership and `a+rX` mode keep root as the only writer while allowing the `baox` service account to read and traverse
the isolated compiler runtime.

## First install

1. **On the mac, pack the commit to deploy.** Name the tarball after the commit; the name becomes the release name.

   ```bash
   sha=$(git rev-parse --short=12 HEAD)
   git archive --format=tar.gz -o "/tmp/baox-$sha.tar.gz" HEAD
   scp "/tmp/baox-$sha.tar.gz" root@10.250.0.222:/tmp/
   ```

   Only committed files are deployed. Done when the tarball is in the host's `/tmp`.

2. **On the host, as root, run the installer from the tarball itself**, naming the administrator account it creates.

   ```bash
   ssh root@10.250.0.222
   sha=<the same 12 characters>
   launcher=$(mktemp -d /tmp/baox-installer.XXXXXX)
   chmod 700 "$launcher"
   tar -xzf "/tmp/baox-$sha.tar.gz" -C "$launcher"
   BAOX_ADMIN_USERNAME=<your username> \
   BAOX_BUILD_PYTHON=/home/baox/.local/share/baox-build-venv/bin/python \
   HTTP_PROXY=http://192.168.2.201:7890 HTTPS_PROXY=http://192.168.2.201:7890 \
   bash "$launcher/deploy/intranet/install.sh" "/tmp/baox-$sha.tar.gz"
   ```

   The installer verifies the private Python, GCC 12.2 or newer, a C++20 probe, the source-built SQLite binding's
   runtime search path, and an in-memory SQLite query before it builds the app. It creates the `baox` system user, downloads Node,
   pnpm and Caddy (checksums verified), builds the release as `baox`, installs the units, starts both services and
   probes them. The build downloads every dependency and takes several minutes; it runs outside the memory cap, so
   start it when the databases are not busy.

   On a new database the first account created becomes the administrator (ADR-0018), so the installer creates yours
   **on the host, before Caddy serves port 80**: until then only `127.0.0.1:4319` answers, and nobody on the VPN can
   reach the setup page first. Without `BAOX_ADMIN_USERNAME` a first install stops there, with Caddy stopped; rerun it
   with the variable set. Done when the last two lines read `baox <name> is serving http://10.250.0.222:
   {"status":"signed_out",...}` and `first administrator: <your username>, temporary password: <…>`. Any other ending
   names the check that failed.

3. **Sign in as the administrator.** From the mac, on the VPN, open `http://10.250.0.222`, sign in with the username
   and the temporary password from step 2, and set your own password when asked. Done when the settings page shows you
   as administrator.

4. **Walk one colleague's path end to end.** Register a second account, approve it as admin, sign in as it, download
   the extension from the settings page, load it unpacked in Chrome or Edge, and pair it. Done when the settings page
   shows the extension as connected.

## Upgrade

Repeat steps 1 and 2 of the first install with the new commit; `BAOX_ADMIN_USERNAME` may be left out, since it is
read only while the database has no administrator. `install.sh` builds the new release beside the running one,
switches `current`, and restarts both services; the database is kept and the app applies its own schema migrations on
start. A running 去报销 (go reimburse) job loses its channel on restart and meets the 120-second
reconnect window (ADR-0020), so upgrade when nobody is filing.

When the release changes the extension, employees re-download it from the settings page and reload it in the browser
(the settings page carries the Chinese walkthrough); the server refuses extensions older than
`EXTENSION_MINIMUM_VERSION`. Running the installer again with the same tarball rebuilds nothing and only restarts.

**Rollback** is `ln -sfn releases/<older> /opt/tools/baox/current && systemctl restart baox`. It is safe only if the
newer release added no schema migration: the database is never migrated backwards, and there is no backup to return to.

**Moving to a domain** is an upgrade too, edited in the repo: the domain's site and the redirect in the `Caddyfile`
(the commented block there shows where), and `BAOX_PUBLIC_ORIGIN` in `baox.service`, in one commit. Every employee then
re-downloads the extension and pairs again, because the old zips carry the old origin, and every web session resets.

## Emergency admin recovery

When the only administrator is locked out (#247), on the host:

```bash
runuser -u baox -- env BAOX_DATA_DIR=/opt/tools/baox/data LD_LIBRARY_PATH=/opt/tools/baox/runtime/gcc-12.5.0/lib64 \
  /opt/tools/baox/runtime/node/bin/node /opt/tools/baox/current/server/dist/baox.mjs admin emergency-reset <username>
```

It prints a 临时密码 (temporary password) that must be changed at the next sign-in. It works while the service runs,
and is audited. It resets only the **only active administrator** (ADR-0018): a shell has no session to say whose
account it is at, and a sole administrator locked out is by definition the one at the shell. With two or more
administrators it refuses, and the other administrator sets a temporary password in the web UI instead. Run it as
`baox`, never as root: the database runs in WAL mode, and a `-wal` or `-shm` file that root creates beside it is one
the service cannot open. `install.sh` runs this same command once, to hand the first administrator a temporary
password.

## Reference

### Origin

`BAOX_PUBLIC_ORIGIN=http://10.250.0.222`, set in `baox.service`, is the deployment's most expensive constant. The app
admits exactly that string as `Origin` and its host part as `Host` (`server/src/public-origin.ts`), and every extension
zip is stamped with it at download. A spelling the browser never writes, such as `http://10.250.0.222:80`, stops the
server at start. Another address, such as the host's own `192.168.1.222`, starts cleanly and is worse: every request
through the VPN address answers 403, and every zip downloaded meanwhile carries an address employees cannot reach, so
each one must be reinstalled. The Caddyfile's site address must be the same string; `install.sh` refuses to install
the two when they differ.

### Reverse proxy

Caddy listens on `:80` and forwards to Node on `127.0.0.1:4319`. It passes the browser's own `Host` and `Origin`
through unchanged, which is Caddy's default, and it carries the extension's WebSocket upgrade on
`/api/extension/channel`, which meets the same `Host` check in the app. It runs as `baox` with only
`CAP_NET_BIND_SERVICE`, with its admin API off; a Caddyfile change takes `systemctl restart baox-caddy`.

### Service user

`baox` is a system user with no login shell. It owns the releases and the data directory; root owns the runtime, the
Caddy binary and the Caddyfile, so the service cannot replace what it runs. The units add `NoNewPrivileges`,
`PrivateTmp`, `ProtectSystem=full` and `ProtectHome`. Node comes from `/opt/tools/baox/runtime/node`, because the
host's Node is root's and older than the `>=24 <25` the repo requires.

### Access path

Employees reach `http://10.250.0.222` only while connected to the company VPN; `10.250.0.222` is how the VPN presents
the host, whose own interface is `192.168.1.222/24`. The VPN is the access boundary. `firewalld` stays inactive on
purpose and there is no host firewall rule to write. Port 4319 is bound to 127.0.0.1 and is never reachable from the
network.

### Memory cap

The host is shared with MySQL, an Oracle client, Grafana and docker. `baox.service` sets `MemoryHigh=1536M`,
`MemoryMax=2G` (with `MemoryLimit=2G` for a cgroup-v1 host) and `OOMScoreAdjust=500`; Caddy gets 256M. At the cap
systemd's cgroup kills baox and `Restart=on-failure` brings it back; the databases are never the ones reclaimed. OCR is
the largest consumer. Check that the cap is in force after the first install:

```bash
systemctl show baox -p MemoryMax -p MemoryLimit -p MemoryCurrent
```

`MemoryCurrent` must be a number, not `[not set]`, and one of the two limits must read 2147483648. A kill at the cap
appears in `journalctl -u baox` as `oom-kill`; raise the cap in the repo's `baox.service` rather than on the host.

### Empty database

The instance starts from an empty database: `install.sh` never writes into the data directory, and `BAOX_HOME` points
at a path that does not exist, so the one-time legacy import (ADR-0015) that runs when the first administrator is
created finds nothing. The installer refuses to run if that path exists. Schema migrations are the app's own and run
on every start; they are not a data move.

### Project catalog on this host

The server holds no project catalog of its own. The check that matters, 报销信息核对 (claim details check) of project
numbers and expense items against the ERP, runs inside each 去报销 job (`checkCatalog` in `erp-executor/src/job.ts`),
in the employee's own logged-in ERP tab through the extension. A mismatch shows on the task as usual.

The production bundle cannot start a browser: nothing it imports reaches `@baox/erp-executor/browser`
(`server/src/production-entry.test.ts`). `BAOX_CHROMIUM_CDP_PORT`, `BAOX_CHROME` and `BAOX_ERP_CHROMIUM` are read only
by the CDP executor, which the production entry never bundles, so none of them is read or validated here. No setting
is needed.

### Troubleshooting

| Symptom | Cause |
|---|---|
| Every page answers 403 `forbidden_host` | The browser's address differs from `BAOX_PUBLIC_ORIGIN`, or something between rewrote `Host` |
| Extension download answers 503 | No extension template at `current/extension/dist`; rerun `install.sh`, which checks the build left it |
| `journalctl -u baox` shows `already used by another baox server` | A second baox process holds `data/server.lock`; stop it |
| Downloads are slow or fail | Set `NODE_MIRROR`, `CADDY_DOWNLOAD` or `npm_config_registry` for the `install.sh` run (see its header) |

## Deployment verification

- On 2026-09-21, release `baox-fdcb4384553c-native-gcc-fix` was deployed from production source commit
  `fdcb4384553c5fe98e05fe066dcc4e8fd1dd42fa`. Archive
  `baox-fdcb4384553c-native-gcc-fix.tar.gz` has SHA-256
  `a44f72c365f97711cf354f159400dc439ee342a71aaea15ed1724b5f92ff3d82`.
- The build runtime is uv 0.12.17, Python 3.12.14 in
  `/home/baox/.local/share/baox-build-venv`, and isolated GCC 12.5.0. Installing the GCC build prerequisites only
  updated `gmp` from `6.2.0-1.ky10` to `6.2.0-2.ky10`; system GCC, glibc, `libstdc++`, and `libgcc` were not replaced.
- The archived installer initially sent loopback probes through the proxy. An installer-only overlay
  `5ee0949430eba52ebab4b9006588250f21cc6cfc8a566ba4e038c8d0a7a0a3c0` was applied to the existing release, adding
  `--noproxy '*'` to local session, setup, and WebSocket curl calls. Future upgrades must use source containing this fix.
- Verified: both systemd units are active and enabled; 4319 binds only to `127.0.0.1`; MemoryHigh is 1536 MiB,
  MemoryMax/MemoryLimit are 2 GiB, and OOMScoreAdjust is 500. The HTTP session is signed out, the WebSocket upgrade is
  101, anonymous extension download is 401, and the extension manifest parses. `better_sqlite3` uses the source
  binding, its upstream prebuild is disabled, its ELF runtime search path targets isolated GCC, and an in-memory SQLite
  query passes.
- The initial administrator was not signed in, its temporary password was not changed, and no ERP or manual browser QA
  was performed.
- The user reported that basic manual QA passed on 2026-09-22. That report covers only "功能基本ok" and does not attest
  to specific ERP actions.
