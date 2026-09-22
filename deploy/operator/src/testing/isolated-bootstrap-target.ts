import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, sign as signPayload } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import type { BootstrapArtifacts, BootstrapTransactionItem, LocalBootstrapArtifact } from '../bootstrap.js';
import { SshHostTransport } from '../host.js';
import { NATIVE_PROFILE, type NativeProfile } from '../profile.js';

type IsolatedBootstrapTargetOptions = Readonly<{
  transaction?: readonly BootstrapTransactionItem[];
  missingMake?: boolean;
  unusableHostCompiler?: boolean;
  denyBaoxPython?: boolean;
  activeRelease?: boolean;
  fenceBootstrapLock?: boolean;
}>;

/** Runs the production host script in a temporary filesystem, never on the real host. */
export class IsolatedBootstrapTarget {
  readonly root: string;
  readonly profile: NativeProfile;
  readonly artifacts: BootstrapArtifacts;
  readonly host: SshHostTransport;
  readonly remoteCommands: string[] = [];

  private readonly artifactSource: string;
  private readonly fakeBin: string;
  private readonly accountMarker: string;
  private readonly dnfMarker: string;
  private readonly gpgMarker: string;
  private readonly proxyLog: string;
  private readonly planPath: string;
  private readonly options: IsolatedBootstrapTargetOptions;

  constructor(options: IsolatedBootstrapTargetOptions = {}) {
    this.options = options;
    this.root = mkdtempSync(join(tmpdir(), 'baox-isolated-bootstrap-'));
    this.artifactSource = join(this.root, 'artifact-source');
    this.fakeBin = join(this.root, 'bin');
    this.accountMarker = join(this.root, 'account-created');
    this.dnfMarker = join(this.root, 'dnf-applied');
    this.gpgMarker = join(this.root, 'gpg-verified');
    this.proxyLog = join(this.root, 'proxy-calls');
    this.planPath = join(this.root, 'transaction.json');
    mkdirSync(this.artifactSource, { recursive: true });
    mkdirSync(this.fakeBin, { recursive: true });
    this.profile = {
      ...NATIVE_PROFILE,
      host: 'isolated.bootstrap.test',
      deployRoot: join(this.root, 'deploy'),
      dataDir: join(this.root, 'data'),
      serviceHome: join(this.root, 'home', 'baox'),
      buildEnvironment: join(this.root, 'deploy', 'etc', 'build.env'),
      buildPython: join(this.root, 'home', 'baox', '.local', 'share', 'baox-build-venv', 'bin', 'python'),
      systemdDir: join(this.root, 'systemd'),
      maintenanceWrapper: join(this.root, 'deploy', 'bin', 'baox-maintenance-gate'),
      maintenanceSocket: join(this.root, 'data', 'maintenance-gate.sock'),
    };
    this.artifacts = fixtureArtifacts(this.artifactSource);
    writeFileSync(this.planPath, JSON.stringify(options.transaction ?? defaultTransaction()));
    mkdirSync(join(this.profile.deployRoot, 'runtime', 'node', 'bin'), { recursive: true });
    symlinkSync(process.execPath, join(this.profile.deployRoot, 'runtime', 'node', 'bin', 'node'));
    if (options.activeRelease) {
      mkdirSync(join(this.profile.deployRoot, 'releases', 'active'), { recursive: true });
      symlinkSync('releases/active', join(this.profile.deployRoot, 'current'));
    }
    this.writeTools();
    this.host = new SshHostTransport({
      profile: this.profile,
      bootstrapArtifacts: this.artifacts,
      runner: async (_profile, remoteCommand, input) => this.run(remoteCommand, input),
      artifactUploader: async (_profile, localPath, targetPath) => {
        mkdirSync(dirname(targetPath), { recursive: true });
        copyFileSync(localPath, targetPath);
      },
    });
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true });
  }

  get appliedPackageTransaction(): boolean {
    return existsSync(this.dnfMarker);
  }

  get createdServiceAccount(): boolean {
    return existsSync(this.accountMarker);
  }

  get verifiedGccSignature(): boolean {
    return existsSync(this.gpgMarker);
  }

  get proxyCalls(): string[] {
    return existsSync(this.proxyLog) ? readFileSync(this.proxyLog, 'utf8').trim().split('\n').filter(Boolean) : [];
  }

  localArtifacts(): readonly LocalBootstrapArtifact[] {
    return artifactList(this.artifacts).map((asset) => ({
      fileName: asset.fileName,
      localPath: join(this.artifactSource, asset.fileName),
      sha256: asset.sha256,
    }));
  }

  relayPath(sha256: string): string {
    return join(this.profile.deployRoot, 'operator-artifacts', sha256);
  }

  holdDeploymentLock(): void {
    const maintenance = join(this.profile.deployRoot, 'maintenance');
    const lock = join(maintenance, 'deployment.lock');
    mkdirSync(lock, { recursive: true, mode: 0o700 });
    const startIdentity = process.platform === 'linux' ? linuxStartIdentity(process.pid) : `nonlinux:${process.pid}`;
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({
      schema: 1,
      operation: 'candidate-prepare',
      candidateId: 'active-candidate',
      pid: process.pid,
      startIdentity,
      token: 'a'.repeat(64),
      createdAt: 'test',
    }) + '\n', { mode: 0o600 });
  }

  private run(remoteCommand: string, input?: Readable): Promise<{ stdout: string; exitCode: number | null }> {
    this.remoteCommands.push(remoteCommand);
    return new Promise((resolve, reject) => {
      const child = spawn('sh', ['-c', remoteCommand], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PATH: `${this.fakeBin}:${process.env.PATH ?? ''}`,
        },
      });
      const stdout: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.resume();
      child.on('error', reject);
      child.on('close', (exitCode) => resolve({ stdout: Buffer.concat(stdout).toString('utf8'), exitCode }));
      child.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') reject(error);
      });
      if (input) {
        input.on('error', reject);
        input.pipe(child.stdin);
      } else {
        child.stdin.end();
      }
    });
  }

  private writeTools(): void {
    const tool = join(this.fakeBin, 'tool');
    writeFileSync(tool, fakeToolScript({
      BAOX_TEST_ACCOUNT: this.accountMarker,
      BAOX_TEST_ARTIFACTS: this.artifactSource,
      BAOX_TEST_DNF_MARKER: this.dnfMarker,
      BAOX_TEST_GCC_PREFIX: join(this.profile.deployRoot, 'runtime', `gcc-${this.artifacts.gcc.version}`),
      BAOX_TEST_GCC_SIGNER: this.artifacts.gccSignature.signerFingerprint,
      BAOX_TEST_GPG_MARKER: this.gpgMarker,
      BAOX_TEST_PNPM_PREFIX: join(this.profile.deployRoot, 'runtime', `pnpm-${this.artifacts.pnpm.version}`),
      BAOX_TEST_PLAN: this.planPath,
      BAOX_TEST_PROXY_LOG: this.proxyLog,
      BAOX_TEST_SERVICE_HOME: this.profile.serviceHome,
      BAOX_TEST_MISSING_MAKE: this.options.missingMake ? '1' : '',
      BAOX_TEST_UNUSABLE_HOST_COMPILER: this.options.unusableHostCompiler ? '1' : '',
      BAOX_TEST_DENY_BAOX_PYTHON: this.options.denyBaoxPython ? '1' : '',
      BAOX_TEST_FENCE_BOOTSTRAP_LOCK: this.options.fenceBootstrapLock ? '1' : '',
    }));
    chmodSync(tool, 0o755);
    for (const name of ['id', 'getent', 'useradd', 'runuser', 'sha256sum', 'sha512sum', 'gpgv', 'curl', 'tar', 'make', 'gcc', 'g++', 'install', 'chown', 'chmod', 'find', 'openssl', 'stat', 'python3']) {
      symlinkSync('tool', join(this.fakeBin, name));
    }
  }
}

function defaultTransaction(): readonly BootstrapTransactionItem[] {
  return [
    { action: 'install', name: 'gmp-devel', nevra: 'gmp-devel-6.2.0-2.ky10.x86_64' },
    { action: 'install', name: 'isl-devel', nevra: 'isl-devel-0.24-1.ky10.x86_64' },
    { action: 'install', name: 'libmpc-devel', nevra: 'libmpc-devel-1.2.1-1.ky10.x86_64' },
    { action: 'install', name: 'mpfr-devel', nevra: 'mpfr-devel-4.1.0-1.ky10.x86_64' },
  ];
}

function fixtureArtifacts(directory: string): BootstrapArtifacts {
  const gcc = fixtureAsset(directory, 'gcc-12.5.0.tar.xz', 'gcc archive');
  const signature = fixtureAsset(directory, 'gcc-12.5.0.tar.xz.sig', 'gcc signature');
  const keyring = fixtureAsset(directory, 'gnu-keyring.gpg', 'gnu keyring');
  const uv = fixtureAsset(directory, 'uv-x86_64-unknown-linux-gnu.tar.gz', 'uv archive');
  const python = fixtureAsset(directory, 'cpython-3.12.14-20260901-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz', 'python archive');
  const pnpm = fixtureAsset(directory, 'pnpm-10.17.1.tgz', 'pnpm archive');
  const integrity = `sha512-${hashFileBase64(join(directory, pnpm.fileName), 'sha512')}`;
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const signerPublicKey = Buffer.from(publicKey.export({ format: 'der', type: 'spki' })).toString('base64');
  const signerKeyId = `test:${createHash('sha256').update(Buffer.from(signerPublicKey, 'base64')).digest('hex')}`;
  const pnpmSignature = signPayload('sha256', Buffer.from(`pnpm@10.17.1:${integrity}`, 'utf8'), privateKey).toString('base64');
  return {
    gcc: { ...gcc, version: '12.5.0', sha512: hashFile(join(directory, gcc.fileName), 'sha512') },
    gccSignature: { ...signature, signerFingerprint: '7F74F97C103468EE5D750B583AB00996FC26A641' },
    gnuKeyring: keyring,
    uv: {
      ...uv,
      version: '0.12.17',
      extractionDirectory: 'uv-test',
      attestation: {
        repository: 'astral-sh/uv',
        signerWorkflow: 'astral-sh/uv/.github/workflows/release.yml',
        sourceCommit: '0000000000000000000000000000000000000000',
        sourceRef: 'refs/heads/main',
      },
    },
    python: {
      ...python,
      version: '3.12.14',
      cacheFileName: 'test-python-cache.tar.gz',
      catalogSourceCommit: '0000000000000000000000000000000000000000',
    },
    pnpm: {
      ...pnpm,
      version: '10.17.1',
      integrity,
      signerKeyId,
      signerPublicKey,
      signature: pnpmSignature,
    },
  };
}

function fixtureAsset(directory: string, fileName: string, contents: string): { fileName: string; sha256: string; url: string } {
  const path = join(directory, fileName);
  writeFileSync(path, contents);
  return { fileName, sha256: hashFile(path, 'sha256'), url: `https://fixtures.test/${fileName}` };
}

function artifactList(artifacts: BootstrapArtifacts): readonly { fileName: string; sha256: string }[] {
  return [artifacts.gcc, artifacts.gccSignature, artifacts.gnuKeyring, artifacts.uv, artifacts.python, artifacts.pnpm];
}

function hashFile(path: string, algorithm: 'sha256' | 'sha512'): string {
  return createHash(algorithm).update(readFileSync(path)).digest('hex');
}

function hashFileBase64(path: string, algorithm: 'sha512'): string {
  return createHash(algorithm).update(readFileSync(path)).digest('base64');
}

function linuxStartIdentity(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u);
  const start = fields[19];
  if (!start || !/^\d+$/u.test(start)) throw new Error('test process lacks a Linux start identity');
  return `linux:${start}`;
}

function fakeToolScript(environment: Readonly<Record<string, string>>): string {
  return String.raw`#!/bin/sh
${Object.entries(environment).map(([name, value]) => `export ${name}=${shellQuote(value)}`).join('\n')}
name=$(basename "$0")
case "$name" in
  id)
    if [ "$1" = '-u' ]; then
      if [ -n "$2" ]; then
        [ "$2" = baox ] && [ -f "$BAOX_TEST_ACCOUNT" ] && { printf '998\n'; exit 0; }
        exit 1
      fi
      printf '0\n'
      exit 0
    fi
    exec /usr/bin/id "$@"
    ;;
  getent)
    [ "$1" = passwd ] && [ "$2" = baox ] && [ -f "$BAOX_TEST_ACCOUNT" ] || exit 2
    printf 'baox:x:998:998::%s:/sbin/nologin\n' "$BAOX_TEST_SERVICE_HOME"
    ;;
  useradd)
    : > "$BAOX_TEST_ACCOUNT"
    mkdir -p "$BAOX_TEST_SERVICE_HOME"
    ;;
  runuser)
    [ "$1" = '-u' ] || exit 2
    shift 2
    [ "$1" = '--' ] && shift
    if [ -n "$BAOX_TEST_DENY_BAOX_PYTHON" ]; then
      for argument in "$@"; do
        case "$argument" in */baox-build-venv/bin/python) exit 126 ;; esac
      done
    fi
    exec "$@"
    ;;
  stat)
    [ "$1" = '-c' ] || exit 2
    format=$2
    path=$3
    case "$path" in
      "$BAOX_TEST_PNPM_PREFIX"|"$BAOX_TEST_PNPM_PREFIX"/*)
        case "$format" in
          %a) printf '755\n' ;;
          %u) printf '0\n' ;;
          *) exit 2 ;;
        esac
        exit 0
        ;;
    esac
    if /usr/bin/stat -c "$format" "$path" >/dev/null 2>&1; then exec /usr/bin/stat -c "$format" "$path"; fi
    case "$format" in
      %a) exec /usr/bin/stat -f '%Lp' "$path" ;;
      %u) exec /usr/bin/stat -f '%u' "$path" ;;
      *) exit 2 ;;
    esac
    ;;
  sha256sum|sha512sum)
    case "$name" in sha256sum) algorithm=256 ;; *) algorithm=512 ;; esac
    case " $* " in
      *' --check '*)
        read -r expected path
        actual=$(/usr/bin/shasum -a "$algorithm" "$path" | awk '{print $1}')
        [ "$expected" = "$actual" ]
        ;;
      *) exec /usr/bin/shasum -a "$algorithm" "$@" ;;
    esac
    ;;
  gpgv)
    : > "$BAOX_TEST_GPG_MARKER"
    printf '[GNUPG:] VALIDSIG %s test-signature\n' "$BAOX_TEST_GCC_SIGNER"
    ;;
  find)
    exit 0
    ;;
  openssl)
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin exec openssl "$@"
    ;;
  curl)
    arguments=$*
    output=''
    while [ "$#" -gt 0 ]; do
      if [ "$1" = '--output' ]; then output=$2; shift 2; continue; fi
      shift
    done
    [ -n "$output" ] || exit 2
    printf '%s\n' "$arguments" >> "$BAOX_TEST_PROXY_LOG"
    cp "$BAOX_TEST_ARTIFACTS/$(basename "$output")" "$output"
    ;;
  tar)
    archive=''
    destination=''
    case "$1" in
      -xJf|-xzf) archive=$2; shift 2 ;;
      *) exit 2 ;;
    esac
    while [ "$#" -gt 0 ]; do
      if [ "$1" = '-C' ]; then destination=$2; shift 2; continue; fi
      shift
    done
    [ -n "$destination" ] || exit 2
    case "$(basename "$archive")" in
      gcc-*)
        mkdir -p "$destination/gcc-12.5.0"
        printf '#!/bin/sh\nexit 0\n' > "$destination/gcc-12.5.0/configure"
        /bin/chmod 0755 "$destination/gcc-12.5.0/configure"
        ;;
      uv-*)
        mkdir -p "$destination/uv-test"
        cat > "$destination/uv-test/uv" <<'EOF'
#!/bin/sh
if [ "$1" = '--version' ]; then printf 'uv 0.12.17\n'; exit 0; fi
if [ "$1" = '--offline' ]; then shift; fi
if [ "$1" = python ] && [ "$2" = install ]; then
  mkdir -p "$UV_PYTHON_INSTALL_DIR/cpython-3.12.14"
  exit 0
fi
if [ "$1" = venv ]; then
  target=$4
  mkdir -p "$target/bin"
  printf '#!/bin/sh\nprintf "3.12.14\\n"\n' > "$target/bin/python"
  chmod 0755 "$target/bin/python"
  exit 0
fi
exit 2
EOF
        /bin/chmod 0755 "$destination/uv-test/uv"
        ;;
      pnpm-*)
        mkdir -p "$destination/package/bin"
        cat > "$destination/package/bin/pnpm.cjs" <<'EOF'
if (process.cwd() !== require('node:fs').realpathSync(process.env.HOME)) process.exit(13);
if (process.argv[2] === '--version') {
  process.stdout.write('10.17.1\n');
  process.exit(0);
}
process.exit(2);
EOF
        ;;
    esac
    ;;
  gcc|g++)
    [ -z "$BAOX_TEST_UNUSABLE_HOST_COMPILER" ] || exit 126
    cat >/dev/null
    ;;
  make)
    [ -z "$BAOX_TEST_MISSING_MAKE" ] || exit 126
    if [ -n "$BAOX_TEST_FENCE_BOOTSTRAP_LOCK" ] && [ "$1" != install ]; then
      deploy_root=$(dirname "$(dirname "$BAOX_TEST_GCC_PREFIX")")
      lock="$deploy_root/maintenance/deployment.lock"
      claim="$lock.test-claim-$$"
      if [ -r "/proc/$$/stat" ]; then
        start=$(awk '{print $22}' "/proc/$$/stat")
        identity="linux:$start"
      else
        identity="nonlinux:$$"
      fi
      mv "$lock" "$claim"
      mkdir "$lock"
      printf '{"schema":1,"operation":"candidate-prepare","candidateId":"successor","pid":%s,"startIdentity":"%s","token":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","createdAt":"test"}\n' "$$" "$identity" > "$lock/owner.json"
      rm -rf "$claim"
    fi
    if [ "$1" = install ]; then
      mkdir -p "$BAOX_TEST_GCC_PREFIX/bin" "$BAOX_TEST_GCC_PREFIX/lib64"
      cat > "$BAOX_TEST_GCC_PREFIX/bin/g++" <<'EOF'
#!/bin/sh
case " $* " in
  *' -dumpfullversion '*) printf '12.5.0\n' ;;
  *) cat >/dev/null ;;
esac
EOF
      printf '#!/bin/sh\ncat >/dev/null\n' > "$BAOX_TEST_GCC_PREFIX/bin/gcc"
      /bin/chmod 0755 "$BAOX_TEST_GCC_PREFIX/bin/g++" "$BAOX_TEST_GCC_PREFIX/bin/gcc"
    fi
    ;;
  install)
    directory=0
    mode=''
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -d) directory=1; shift ;;
        -o|-g) shift 2 ;;
        -m) mode=$2; shift 2 ;;
        *) break ;;
      esac
    done
    if [ "$directory" = 1 ]; then
      for destination in "$@"; do mkdir -p "$destination"; done
      exit 0
    fi
    source=$1
    destination=$2
    mkdir -p "$(dirname "$destination")"
    cp "$source" "$destination"
    [ -n "$mode" ] && /bin/chmod "$mode" "$destination"
    ;;
  chown)
    exit 0
    ;;
  chmod)
    exec /bin/chmod "$@"
    ;;
  python3)
    if [ "$1" = '-c' ] && [ "$2" = 'import dnf' ]; then exit 0; fi
    if [ "$1" = '-' ] && { [ "$2" = preview ] || [ "$2" = check ] || [ "$2" = apply ]; }; then
      phase=$2
      expected=$3
      exec /usr/bin/python3 - "$phase" "$expected" "$BAOX_TEST_PLAN" "$BAOX_TEST_DNF_MARKER" <<'PY'
import hashlib
import json
import pathlib
import sys

phase, expected, plan_path, marker = sys.argv[1:]
requested = ['gmp-devel', 'mpfr-devel', 'libmpc-devel', 'isl-devel']
items = sorted(json.load(open(plan_path, encoding='utf-8')), key=lambda item: (item['name'], item['action'], item['nevra']))
protected_prefixes = ('gcc', 'glibc', 'libstdc++', 'libgcc')
protected = [item for item in items if any(item['name'] == prefix or item['name'].startswith(prefix + '-') for prefix in protected_prefixes)]
canonical = json.dumps({'requested': requested, 'transaction': items}, sort_keys=True, separators=(',', ':'))
plan = {'transaction': items, 'transactionDigest': hashlib.sha256(canonical.encode('utf-8')).hexdigest(), 'protectedActions': protected}
def emit(state, reason=None):
    response = {'version': 1, 'state': state, 'plan': plan}
    if reason is not None:
        response['reason'] = reason
    print(json.dumps(response, sort_keys=True, separators=(',', ':')))
if phase == 'preview':
    emit('preview')
    raise SystemExit(0)
if protected:
    emit('protected-transaction', 'the proposed transaction changes a protected system runtime package')
    raise SystemExit(20)
if expected != plan['transactionDigest']:
    emit('confirmation-mismatch', 'the package transaction differs from the reviewed preview')
    raise SystemExit(21)
if phase == 'apply':
    pathlib.Path(marker).write_text('applied', encoding='utf-8')
emit('confirmed')
PY
    fi
    exec /usr/bin/python3 "$@"
    ;;
  *) exit 2 ;;
esac
`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
