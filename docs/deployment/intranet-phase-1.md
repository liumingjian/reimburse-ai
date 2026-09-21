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
only under `/root/.nvm`.

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
| `/opt/tools/baox/bin/caddy` | root | Caddy, one static binary, version pinned in `install.sh` |
| `/opt/tools/baox/etc/Caddyfile` | root | Installed from `deploy/intranet/Caddyfile` |
| `/opt/tools/baox/cache/` | baox | pnpm store and the build's home directory |
| `/etc/systemd/system/baox.service`, `baox-caddy.service` | root | The two units; nothing else is written outside `/opt/tools/baox` |

## First install

1. **On the mac, pack the commit to deploy.** Name the tarball after the commit; the name becomes the release name.

   ```bash
   sha=$(git rev-parse --short=12 HEAD)
   git archive --format=tar.gz -o "/tmp/baox-$sha.tar.gz" HEAD
   scp "/tmp/baox-$sha.tar.gz" root@10.250.0.222:/tmp/
   ```

   Only committed files are deployed. Done when the tarball is in the host's `/tmp`.

2. **On the host, as root, run the installer from the tarball itself.**

   ```bash
   ssh root@10.250.0.222
   sha=<the same 12 characters>
   tar -xzf "/tmp/baox-$sha.tar.gz" -C /tmp deploy/intranet/install.sh
   bash /tmp/deploy/intranet/install.sh "/tmp/baox-$sha.tar.gz"
   ```

   The build compiles `better-sqlite3`, so the host needs `python3`, `make` and `g++` (`dnf install -y python3 make
   gcc-c++`); the installer stops and says so when one is missing. It creates the `baox` system user, downloads Node, pnpm and Caddy (checksums verified), builds the release as
   `baox`, installs the units, starts both services and probes them. The build downloads every dependency and takes
   several minutes; it runs outside the memory cap, so start it when the databases are not busy. Done when the last line
   reads `baox <name> is serving http://10.250.0.222: {"status":"setup_required",...}`. Any other ending names the
   check that failed.

3. **Create the administrator at once.** On a new database the first account created becomes the administrator, and
   anyone on the VPN can reach the page. From the mac, on the VPN, open `http://10.250.0.222` and set up the admin
   account. Done when the settings page shows you as administrator. If someone else got there first: `systemctl stop
   baox`, empty `/opt/tools/baox/data`, `systemctl start baox`, and repeat. Nothing real is lost, since phase 1 holds
   no real data.

4. **Walk one colleague's path end to end.** Register a second account, approve it as admin, sign in as it, download
   the extension from the settings page, load it unpacked in Chrome or Edge, and pair it. Done when the settings page
   shows the extension as connected.

## Upgrade

Repeat steps 1 and 2 of the first install with the new commit. `install.sh` builds the new release beside the running
one, switches `current`, and restarts both services; the database is kept and the app applies its own schema
migrations on start. A running 去报销 (go reimburse) job loses its channel on restart and meets the 120-second
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
runuser -u baox -- env BAOX_DATA_DIR=/opt/tools/baox/data \
  /opt/tools/baox/runtime/node/bin/node /opt/tools/baox/current/server/dist/baox.mjs admin emergency-reset <username>
```

It prints a 临时密码 (temporary password) that must be changed at the next sign-in. It works while the service runs,
touches administrators only, and is audited. Run it as `baox`, never as root: the database runs in WAL mode, and a
`-wal` or `-shm` file that root creates beside it is one the service cannot open.

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

The production bundle still contains `@baox/erp-executor/browser`, which can spawn Chromium, because `server/src/run.ts`
builds a live project catalog over `cdpBrowser(cdpPortOf())`. On this host, which has no Chromium, that is inert:

- `createApp` receives the catalog and never reads it (`server/src/app.ts`: project-book intake no longer queries it),
  so no request ever calls its `lookup`. Nothing in the production path calls `ensureChromium`, so nothing spawns a
  browser.
- The check that matters, 报销信息核对 (claim details check) of project numbers and expense items against the ERP,
  runs inside each 去报销 job (`checkCatalog` in `erp-executor/src/job.ts`), in the employee's own logged-in ERP tab
  through the extension. A mismatch shows on the task as usual; 去报销 is unaffected.
- The only startup effect is `cdpPortOf()` validating `BAOX_CHROMIUM_CDP_PORT`. Leave it unset; an invalid value stops
  the server.
- `BAOX_ERP_CHROMIUM=off` is read only by the CDP executor, which the production entry never bundles
  (`server/src/production-entry.test.ts`). Setting it changes nothing here.

No setting is needed. Removing the dead wiring belongs to the #246 code review, not this deployment.

### Troubleshooting

| Symptom | Cause |
|---|---|
| Every page answers 403 `forbidden_host` | The browser's address differs from `BAOX_PUBLIC_ORIGIN`, or something between rewrote `Host` |
| Extension download answers 503 | No extension template at `current/extension/dist`; rerun `install.sh`, which checks the build left it |
| `journalctl -u baox` shows `already used by another baox server` | A second baox process holds `data/server.lock`; stop it |
| Downloads are slow or fail | Set `NODE_MIRROR`, `CADDY_DOWNLOAD` or `npm_config_registry` for the `install.sh` run (see its header) |

## 维护者备注

（此处留给维护者用中文记录部署时的实际情况：日期、提交号、遇到的问题。）
