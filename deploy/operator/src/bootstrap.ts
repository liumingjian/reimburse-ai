import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { NativeProfile } from './profile.js';

export type BootstrapAsset = Readonly<{
  fileName: string;
  sha256: string;
  url: string;
}>;

export type UvAttestation = Readonly<{
  repository: string;
  signerWorkflow: string;
  sourceCommit: string;
  sourceRef: string;
}>;

export type BootstrapArtifacts = Readonly<{
  gcc: BootstrapAsset & Readonly<{ sha512: string; version: string }>;
  gccSignature: BootstrapAsset & Readonly<{ signerFingerprint: string }>;
  gnuKeyring: BootstrapAsset;
  uv: BootstrapAsset & Readonly<{ version: string; extractionDirectory: string; attestation: UvAttestation }>;
  python: BootstrapAsset & Readonly<{ version: string; cacheFileName: string; catalogSourceCommit: string }>;
}>;

export const BOOTSTRAP_ARTIFACTS: BootstrapArtifacts = {
  gcc: {
    fileName: 'gcc-12.5.0.tar.xz',
    version: '12.5.0',
    sha256: '71cd373d0f04615e66c5b5b14d49c1a4c1a08efa7b30625cd240b11bab4062b3',
    sha512: 'c76020e4c844b53485502cb8a4e295221c9d37487d66c9f4559031fb14c85de20602e6387310005386cb0ef25e55067d2cfef141423bb445f3b77e7456a23533',
    url: 'https://gcc.gnu.org/pub/gcc/releases/gcc-12.5.0/gcc-12.5.0.tar.xz',
  },
  gccSignature: {
    fileName: 'gcc-12.5.0.tar.xz.sig',
    sha256: 'c5a0cfe77b541f5b694cca334a890d9c3a4aa1d3be67b1080ca002ceddc18cd2',
    signerFingerprint: '7F74F97C103468EE5D750B583AB00996FC26A641',
    url: 'https://gcc.gnu.org/pub/gcc/releases/gcc-12.5.0/gcc-12.5.0.tar.xz.sig',
  },
  gnuKeyring: {
    fileName: 'gnu-keyring.gpg',
    sha256: 'b136fbe57ade4ee5270ca66c402cae7b50349fd07646b5b3de7962d58d4df608',
    url: 'https://ftp.gnu.org/gnu/gnu-keyring.gpg',
  },
  uv: {
    fileName: 'uv-x86_64-unknown-linux-gnu.tar.gz',
    version: '0.12.17',
    extractionDirectory: 'uv-x86_64-unknown-linux-gnu',
    sha256: 'fa82fd8dde8e8eefdecada6aa0889666556cfceb690d06e0c3bca49eb3070a63',
    url: 'https://github.com/astral-sh/uv/releases/download/0.12.17/uv-x86_64-unknown-linux-gnu.tar.gz',
    attestation: {
      repository: 'astral-sh/uv',
      signerWorkflow: 'astral-sh/uv/.github/workflows/release.yml',
      sourceCommit: '635500036e1705961315e86447f0fab0a8ddb309',
      sourceRef: 'refs/heads/main',
    },
  },
  python: {
    fileName: 'cpython-3.12.14-20260901-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz',
    version: '3.12.14',
    cacheFileName: '72748da13-cpython-3.12.14-20260901-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz',
    catalogSourceCommit: '635500036e1705961315e86447f0fab0a8ddb309',
    sha256: '72748da13197c1fb161e3afeef20a6a385ff24f2165e6e2758e47008e7faba4c',
    url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20260901/cpython-3.12.14%2B20260901-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz',
  },
} as const;

export type BootstrapSource = Readonly<{
  kind: 'proxy' | 'relay';
  proxy: string;
}>;

export type LocalBootstrapArtifact = Readonly<{
  fileName: string;
  localPath: string;
  sha256: string;
}>;

export type BootstrapProvenanceVerifier = (
  source: BootstrapSource,
  relayArtifacts: readonly LocalBootstrapArtifact[] | undefined,
) => Promise<void>;

export type BootstrapTransactionItem = Readonly<{
  action: string;
  name: string;
  nevra: string;
}>;

export type BootstrapPlan = Readonly<{
  transaction: readonly BootstrapTransactionItem[];
  transactionDigest: string;
  protectedActions: readonly BootstrapTransactionItem[];
}>;

export type BootstrapReadiness = Readonly<{
  serviceAccount: 'ready';
  gccVersion: string;
  pythonVersion: string;
  uvVersion: string;
  buildEnvironmentSha256: string;
}>;

export type BootstrapResponse =
  | Readonly<{ version: 1; state: 'preview' | 'confirmed'; plan: BootstrapPlan }>
  | Readonly<{ version: 1; state: 'protected-transaction' | 'confirmation-mismatch' | 'prerequisite-refused'; plan: BootstrapPlan; reason: string }>
  | Readonly<{ version: 1; state: 'applied'; plan: BootstrapPlan; readiness: BootstrapReadiness }>;

export class BootstrapInputError extends Error {}

export function validateBootstrapProxy(value: string): string {
  if (!value || /[\r\n]/u.test(value) || value.includes('@')) {
    throw new BootstrapInputError('代理地址必须是不含凭据的 HTTP 或 HTTPS URL。');
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new BootstrapInputError('代理地址必须是不含凭据的 HTTP 或 HTTPS URL。');
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new BootstrapInputError('代理地址必须是不含凭据的 HTTP 或 HTTPS URL。');
  }
  return value;
}

export async function resolveRelayArtifacts(directory: string, artifacts: BootstrapArtifacts = BOOTSTRAP_ARTIFACTS): Promise<readonly LocalBootstrapArtifact[]> {
  if (!directory || directory.includes('\0')) throw new BootstrapInputError('中继目录必须是本机上的目录。');
  const resolved: LocalBootstrapArtifact[] = [];
  for (const asset of bootstrapAssets(artifacts)) {
    const localPath = join(directory, asset.fileName);
    let metadata;
    try {
      metadata = await stat(localPath);
    } catch {
      throw new BootstrapInputError(`中继目录缺少 ${asset.fileName}。`);
    }
    if (!metadata.isFile()) throw new BootstrapInputError(`中继项不是普通文件：${asset.fileName}。`);
    const sha256 = await sha256File(localPath);
    if (sha256 !== asset.sha256) throw new BootstrapInputError(`中继项 SHA-256 不匹配：${asset.fileName}。`);
    resolved.push({ fileName: asset.fileName, localPath, sha256 });
  }
  return resolved;
}

/**
 * Authenticate the uv release bytes before an apply. The target repeats the
 * digest checks, so proxy and relay transfer cannot weaken this provenance.
 */
export const verifyBootstrapProvenance: BootstrapProvenanceVerifier = async (source, relayArtifacts) => {
  validateBootstrapProxy(source.proxy);
  if (source.kind === 'relay') {
    const uv = relayArtifacts?.find((artifact) => artifact.fileName === BOOTSTRAP_ARTIFACTS.uv.fileName);
    if (!uv) throw new BootstrapInputError('中继来源缺少 uv 工件，无法验证发布来源。');
    await verifyUvReleaseProvenance(uv.localPath, BOOTSTRAP_ARTIFACTS);
    return;
  }

  const directory = await mkdtemp(join(tmpdir(), 'baox-uv-provenance-'));
  const localPath = join(directory, BOOTSTRAP_ARTIFACTS.uv.fileName);
  try {
    await runCommand(
      'curl',
      [
        '--fail', '--location', '--silent', '--show-error', '--retry', '3', '--proto', '=https', '--tlsv1.2',
        '--proxy', source.proxy, '--output', localPath, BOOTSTRAP_ARTIFACTS.uv.url,
      ],
      '无法通过指定代理获取 uv 发布工件以验证来源。',
    );
    await verifyUvReleaseProvenance(localPath, BOOTSTRAP_ARTIFACTS);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

export function bootstrapArtifactDirectory(profile: NativeProfile): string {
  return `${profile.deployRoot}/operator-artifacts`;
}

export function bootstrapArtifactName(fileName: string): string {
  if (basename(fileName) !== fileName || !/^[A-Za-z0-9._-]+$/u.test(fileName)) {
    throw new BootstrapInputError('引导工件名称无效。');
  }
  return fileName;
}

export function bootstrapArtifactForName(fileName: string, artifacts: BootstrapArtifacts = BOOTSTRAP_ARTIFACTS): BootstrapAsset | undefined {
  return bootstrapAssets(artifacts).find((asset) => asset.fileName === fileName);
}

export function parseBootstrapResponse(output: string): BootstrapResponse {
  const lines = output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).reverse();
  for (const line of lines) {
    try {
      const candidate: unknown = JSON.parse(line);
      if (isBootstrapResponse(candidate)) return candidate;
    } catch {
      // The remote package manager may print progress before the response.
    }
  }
  throw new Error('主机返回的 bootstrap 响应不兼容。');
}

export function bootstrapScript(
  profile: NativeProfile,
  request: Readonly<{ mode: 'preview' | 'apply'; source: BootstrapSource; confirmationDigest?: string }>,
  artifacts: BootstrapArtifacts = BOOTSTRAP_ARTIFACTS,
): string {
  const relayDirectory = bootstrapArtifactDirectory(profile);
  const q = shellQuote;
  return String.raw`
set -eu
MODE=${q(request.mode)}
SOURCE_KIND=${q(request.source.kind)}
PROXY=${q(request.source.proxy)}
EXPECTED_DIGEST=${q(request.confirmationDigest ?? '')}
DEPLOY_ROOT=${q(profile.deployRoot)}
SERVICE_HOME=${q(profile.serviceHome)}
BUILD_ENV=${q(profile.buildEnvironment)}
RELAY_DIRECTORY=${q(relayDirectory)}
GCC_VERSION=${q(artifacts.gcc.version)}
GCC_FILE=${q(artifacts.gcc.fileName)}
GCC_URL=${q(artifacts.gcc.url)}
GCC_SHA256=${q(artifacts.gcc.sha256)}
GCC_SHA512=${q(artifacts.gcc.sha512)}
GCC_SIGNATURE_FILE=${q(artifacts.gccSignature.fileName)}
GCC_SIGNATURE_URL=${q(artifacts.gccSignature.url)}
GCC_SIGNATURE_SHA256=${q(artifacts.gccSignature.sha256)}
GCC_SIGNER_FINGERPRINT=${q(artifacts.gccSignature.signerFingerprint)}
GNU_KEYRING_FILE=${q(artifacts.gnuKeyring.fileName)}
GNU_KEYRING_URL=${q(artifacts.gnuKeyring.url)}
GNU_KEYRING_SHA256=${q(artifacts.gnuKeyring.sha256)}
UV_VERSION=${q(artifacts.uv.version)}
UV_FILE=${q(artifacts.uv.fileName)}
UV_URL=${q(artifacts.uv.url)}
UV_SHA256=${q(artifacts.uv.sha256)}
UV_DIRECTORY=${q(artifacts.uv.extractionDirectory)}
PYTHON_VERSION=${q(artifacts.python.version)}
PYTHON_FILE=${q(artifacts.python.fileName)}
PYTHON_URL=${q(artifacts.python.url)}
PYTHON_SHA256=${q(artifacts.python.sha256)}
PYTHON_CACHE_FILE=${q(artifacts.python.cacheFileName)}
BAOX_USER=baox
NO_PROXY_VALUE=127.0.0.1,localhost
RUNTIME=$DEPLOY_ROOT/runtime
GCC_PREFIX=$RUNTIME/gcc-$GCC_VERSION
GCC_LIBDIR=$GCC_PREFIX/lib64
UV_BIN=$SERVICE_HOME/.local/bin/uv
UV_CACHE_DIR=$SERVICE_HOME/.cache/uv
UV_PYTHON_INSTALL_DIR=$SERVICE_HOME/.local/share/uv/python
UV_PYTHON_CACHE_DIR=$SERVICE_HOME/.cache/uv/python-builds
BUILD_VENV=$SERVICE_HOME/.local/share/baox-build-venv

die() {
  printf 'bootstrap: %s\n' "$*" >&2
  exit 70
}

emit_refusal() {
  printf '{"version":1,"state":"prerequisite-refused","plan":{"transaction":[],"transactionDigest":"0000000000000000000000000000000000000000000000000000000000000000","protectedActions":[]},"reason":"%s"}\n' "$1"
  exit 0
}

require_root() {
  [ "$(id -u)" = 0 ] || die 'bootstrap must run as root on the fixed host'
}

validate_proxy() {
  case $PROXY in
    http://*|https://*) ;;
    *) die 'proxy must be an HTTP or HTTPS URL' ;;
  esac
  case $PROXY in *@*) die 'proxy must not contain credentials' ;; esac
}

assert_account_layout() {
  if id -u "$BAOX_USER" >/dev/null 2>&1; then
    account_home=$(getent passwd "$BAOX_USER" | awk -F: '{print $6}')
    [ "$account_home" = "$SERVICE_HOME" ] || emit_refusal 'baox already exists with a different home; correct that account manually before bootstrap'
  fi
}

dnf_phase() {
  python3 - "$1" "$EXPECTED_DIGEST" <<'PY'
import hashlib
import json
import logging
import sys

import dnf
from dnf import transaction as dnf_transaction

phase = sys.argv[1]
expected_digest = sys.argv[2]
requested = ['gmp-devel', 'mpfr-devel', 'libmpc-devel', 'isl-devel']
protected_prefixes = ('gcc', 'glibc', 'libstdc++', 'libgcc')
action_names = {}
for constant, name in (
    ('PKG_DOWNGRADE', 'downgrade'),
    ('PKG_DOWNGRADED', 'downgraded'),
    ('PKG_ERASE', 'remove'),
    ('PKG_INSTALL', 'install'),
    ('PKG_OBSOLETE', 'obsolete'),
    ('PKG_OBSOLETED', 'obsoleted'),
    ('PKG_REINSTALL', 'reinstall'),
    ('PKG_REINSTALLED', 'reinstalled'),
    ('PKG_UPGRADE', 'upgrade'),
    ('PKG_UPGRADED', 'upgraded'),
):
    value = getattr(dnf_transaction, constant, None)
    if value is not None:
        action_names[value] = name

def is_protected(name):
    return any(name == prefix or name.startswith(prefix + '-') for prefix in protected_prefixes)

def emit(state, plan, reason=None):
    response = {'version': 1, 'state': state, 'plan': plan}
    if reason is not None:
        response['reason'] = reason
    print(json.dumps(response, sort_keys=True, separators=(',', ':')))

logging.disable(logging.CRITICAL)
base = dnf.Base()
base.read_all_repos()
base.fill_sack(load_system_repo=True, load_available_repos=True)
for package in requested:
    base.install(package)
base.resolve()
items = []
for item in base.transaction:
    package = item.pkg
    items.append({
        'action': action_names.get(item.action, 'unknown'),
        'name': package.name,
        'nevra': str(package),
    })
items.sort(key=lambda item: (item['name'], item['action'], item['nevra']))
protected = [item for item in items if is_protected(item['name'])]
canonical = json.dumps({'requested': requested, 'transaction': items}, sort_keys=True, separators=(',', ':'))
plan = {
    'transaction': items,
    'transactionDigest': hashlib.sha256(canonical.encode('utf-8')).hexdigest(),
    'protectedActions': protected,
}
if phase == 'preview':
    emit('preview', plan)
    sys.exit(0)
if protected:
    emit('protected-transaction', plan, 'the proposed transaction changes a protected system runtime package')
    sys.exit(20)
if expected_digest != plan['transactionDigest']:
    emit('confirmation-mismatch', plan, 'the package transaction differs from the reviewed preview')
    sys.exit(21)
if phase == 'check':
    emit('confirmed', plan)
    sys.exit(0)
if phase != 'apply':
    raise RuntimeError('unsupported bootstrap package phase')
base.conf.assumeyes = True
base.do_transaction()
emit('confirmed', plan)
PY
}

copy_relay_asset() {
  expected_sha=$1
  file_name=$2
  source_path=$RELAY_DIRECTORY/$expected_sha
  [ -f "$source_path" ] || die "missing relayed artifact $file_name"
  cp "$source_path" "$WORK/$file_name"
}

download_asset() {
  url=$1
  file_name=$2
  curl --fail --location --silent --show-error --retry 3 --proto '=https' --tlsv1.2 --proxy "$PROXY" --output "$WORK/$file_name" "$url"
}

obtain_assets() {
  if [ "$SOURCE_KIND" = relay ]; then
    copy_relay_asset "$GCC_SHA256" "$GCC_FILE"
    copy_relay_asset "$GCC_SIGNATURE_SHA256" "$GCC_SIGNATURE_FILE"
    copy_relay_asset "$GNU_KEYRING_SHA256" "$GNU_KEYRING_FILE"
    copy_relay_asset "$UV_SHA256" "$UV_FILE"
    copy_relay_asset "$PYTHON_SHA256" "$PYTHON_FILE"
    return
  fi
  download_asset "$GCC_URL" "$GCC_FILE"
  download_asset "$GCC_SIGNATURE_URL" "$GCC_SIGNATURE_FILE"
  download_asset "$GNU_KEYRING_URL" "$GNU_KEYRING_FILE"
  download_asset "$UV_URL" "$UV_FILE"
  download_asset "$PYTHON_URL" "$PYTHON_FILE"
}

check_sha256() {
  expected=$1
  file_name=$2
  printf '%s  %s\n' "$expected" "$file_name" | (cd "$WORK" && sha256sum --strict --check --status -) || die "SHA-256 verification failed for $file_name"
}

check_sha512() {
  expected=$1
  file_name=$2
  printf '%s  %s\n' "$expected" "$file_name" | (cd "$WORK" && sha512sum --strict --check --status -) || die "SHA-512 verification failed for $file_name"
}

verify_assets() {
  check_sha256 "$GCC_SHA256" "$GCC_FILE"
  check_sha512 "$GCC_SHA512" "$GCC_FILE"
  check_sha256 "$GCC_SIGNATURE_SHA256" "$GCC_SIGNATURE_FILE"
  check_sha256 "$GNU_KEYRING_SHA256" "$GNU_KEYRING_FILE"
  check_sha256 "$UV_SHA256" "$UV_FILE"
  check_sha256 "$PYTHON_SHA256" "$PYTHON_FILE"
  gpg_status=$(gpgv --status-fd 1 --keyring "$WORK/$GNU_KEYRING_FILE" "$WORK/$GCC_SIGNATURE_FILE" "$WORK/$GCC_FILE" 2>/dev/null) || die 'GCC detached signature verification failed'
  printf '%s\n' "$gpg_status" | grep -F "[GNUPG:] VALIDSIG $GCC_SIGNER_FINGERPRINT " >/dev/null || die 'GCC signature did not use the pinned signer fingerprint'
}

ensure_account() {
  if ! id -u "$BAOX_USER" >/dev/null 2>&1; then
    useradd --system --user-group --home-dir "$SERVICE_HOME" --create-home --shell /sbin/nologin "$BAOX_USER"
  fi
  install -d -o "$BAOX_USER" -g "$BAOX_USER" -m 0750 "$SERVICE_HOME" "$SERVICE_HOME/.local" "$SERVICE_HOME/.local/bin" "$SERVICE_HOME/.local/share" "$SERVICE_HOME/.cache" "$UV_PYTHON_CACHE_DIR"
}

write_build_environment() {
  install -d -o root -g root -m 0755 "$(dirname "$BUILD_ENV")"
  temporary_environment=$(mktemp "$(dirname "$BUILD_ENV")/.build.env.XXXXXX")
  umask 077
  {
    printf 'HTTP_PROXY=%s\n' "$PROXY"
    printf 'HTTPS_PROXY=%s\n' "$PROXY"
    printf 'NO_PROXY=%s\n' "$NO_PROXY_VALUE"
  } > "$temporary_environment"
  install -o root -g root -m 0600 "$temporary_environment" "$BUILD_ENV"
  rm -f "$temporary_environment"
}

as_baox() {
  runuser -u "$BAOX_USER" -- env -i \
    HOME="$SERVICE_HOME" \
    PATH="$SERVICE_HOME/.local/bin:/usr/local/bin:/usr/bin:/bin" \
    HTTP_PROXY="$PROXY" \
    HTTPS_PROXY="$PROXY" \
    NO_PROXY="$NO_PROXY_VALUE" \
    UV_CACHE_DIR="$UV_CACHE_DIR" \
    UV_PYTHON_INSTALL_DIR="$UV_PYTHON_INSTALL_DIR" \
    UV_PYTHON_CACHE_DIR="$UV_PYTHON_CACHE_DIR" \
    CC="$GCC_PREFIX/bin/gcc" \
    CXX="$GCC_PREFIX/bin/g++" \
    LD_LIBRARY_PATH="$GCC_LIBDIR" \
    "$@"
}

install_gcc() {
  if [ -x "$GCC_PREFIX/bin/g++" ] && [ "$(LD_LIBRARY_PATH="$GCC_LIBDIR" "$GCC_PREFIX/bin/g++" -dumpfullversion -dumpversion 2>/dev/null || true)" = "$GCC_VERSION" ]; then
    return
  fi
  rm -rf "$GCC_PREFIX"
  tar -xJf "$WORK/$GCC_FILE" -C "$WORK"
  mkdir -p "$WORK/gcc-build"
  (
    cd "$WORK/gcc-build"
    MAKEINFO=true "$WORK/gcc-$GCC_VERSION/configure" --prefix="$GCC_PREFIX" --disable-bootstrap \
      --enable-languages=c,c++ --disable-multilib --disable-nls --disable-libsanitizer \
      --with-gmp=/usr --with-mpfr=/usr --with-mpc=/usr --with-isl=/usr
    make -j2
    make install
  )
  chown -R root:root "$GCC_PREFIX"
  chmod -R a+rX "$GCC_PREFIX"
}

install_uv_and_python() {
  tar -xzf "$WORK/$UV_FILE" -C "$WORK"
  [ -x "$WORK/$UV_DIRECTORY/uv" ] || die 'verified uv archive contains no uv executable'
  install -o "$BAOX_USER" -g "$BAOX_USER" -m 0755 "$WORK/$UV_DIRECTORY/uv" "$UV_BIN"
  install -o "$BAOX_USER" -g "$BAOX_USER" -m 0644 "$WORK/$PYTHON_FILE" "$UV_PYTHON_CACHE_DIR/$PYTHON_CACHE_FILE"
  as_baox "$UV_BIN" --offline python install "$PYTHON_VERSION"
  if [ -x "$BUILD_VENV/bin/python" ]; then
    existing_python=$($BUILD_VENV/bin/python -c 'import sys; print(".".join(map(str, sys.version_info[:3])))')
    [ "$existing_python" = "$PYTHON_VERSION" ] || rm -rf "$BUILD_VENV"
  fi
  if [ ! -x "$BUILD_VENV/bin/python" ]; then
    as_baox "$UV_BIN" venv --python "$PYTHON_VERSION" "$BUILD_VENV"
  fi
}

verify_readiness() {
  gcc_version=$(LD_LIBRARY_PATH="$GCC_LIBDIR" "$GCC_PREFIX/bin/g++" -dumpfullversion -dumpversion 2>/dev/null) || die 'isolated GCC cannot run'
  [ "$gcc_version" = "$GCC_VERSION" ] || die "isolated GCC version is $gcc_version, expected $GCC_VERSION"
  python_version=$($BUILD_VENV/bin/python -c 'import sys; print(".".join(map(str, sys.version_info[:3])))') || die 'build virtual environment cannot run Python'
  [ "$python_version" = "$PYTHON_VERSION" ] || die "build Python version is $python_version, expected $PYTHON_VERSION"
  uv_version=$($UV_BIN --version | awk '{print $2}') || die 'uv cannot run'
  [ "$uv_version" = "$UV_VERSION" ] || die "uv version is $uv_version, expected $UV_VERSION"
  grep -Fqx "HTTP_PROXY=$PROXY" "$BUILD_ENV" || die 'build environment lacks HTTP_PROXY'
  grep -Fqx "HTTPS_PROXY=$PROXY" "$BUILD_ENV" || die 'build environment lacks HTTPS_PROXY'
  grep -Fqx "NO_PROXY=$NO_PROXY_VALUE" "$BUILD_ENV" || die 'build environment lacks NO_PROXY'
  printf 'int main() { return 0; }\n' | as_baox "$GCC_PREFIX/bin/g++" -std=c++20 -x c++ -fsyntax-only - >/dev/null
  as_baox sh -c 'test "$HTTP_PROXY" = "$1" && test "$HTTPS_PROXY" = "$1" && test "$NO_PROXY" = "$2"' _ "$PROXY" "$NO_PROXY_VALUE" || die 'baox build environment is incomplete'
  build_environment_sha256=$(sha256sum "$BUILD_ENV" | awk '{print $1}')
}

emit_applied() {
  python3 - "$TRANSACTION_RESULT" "$gcc_version" "$python_version" "$uv_version" "$build_environment_sha256" <<'PY'
import json
import sys

def response_from_file(path):
    for line in reversed(open(path, encoding='utf-8').read().splitlines()):
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and value.get('version') == 1 and value.get('state') == 'confirmed':
            return value
    raise RuntimeError('missing transaction response')

transaction = response_from_file(sys.argv[1])
print(json.dumps({
    'version': 1,
    'state': 'applied',
    'plan': transaction['plan'],
    'readiness': {
        'serviceAccount': 'ready',
        'gccVersion': sys.argv[2],
        'pythonVersion': sys.argv[3],
        'uvVersion': sys.argv[4],
        'buildEnvironmentSha256': sys.argv[5],
    },
}, sort_keys=True, separators=(',', ':')))
PY
}

require_root
validate_proxy
assert_account_layout
if [ "$MODE" = preview ]; then
  dnf_phase preview
  exit 0
fi

WORK=$(mktemp -d /tmp/baox-bootstrap.XXXXXX)
TRANSACTION_RESULT=$WORK/transaction.json
trap 'rm -rf "$WORK"' EXIT HUP INT TERM
if dnf_phase check > "$TRANSACTION_RESULT"; then
  :
else
  dnf_status=$?
  if [ "$dnf_status" = 20 ] || [ "$dnf_status" = 21 ]; then
    cat "$TRANSACTION_RESULT"
    exit 0
  fi
  exit "$dnf_status"
fi
obtain_assets
verify_assets
if dnf_phase apply > "$TRANSACTION_RESULT"; then
  :
else
  dnf_status=$?
  if [ "$dnf_status" = 20 ] || [ "$dnf_status" = 21 ]; then
    cat "$TRANSACTION_RESULT"
    exit 0
  fi
  exit "$dnf_status"
fi
ensure_account
write_build_environment
install_gcc
install_uv_and_python
verify_readiness
emit_applied
`;
}

function bootstrapAssets(artifacts: BootstrapArtifacts): readonly BootstrapAsset[] {
  return [artifacts.gcc, artifacts.gccSignature, artifacts.gnuKeyring, artifacts.uv, artifacts.python];
}

async function verifyUvReleaseProvenance(localPath: string, artifacts: BootstrapArtifacts): Promise<void> {
  const sha256 = await sha256File(localPath);
  if (sha256 !== artifacts.uv.sha256) {
    throw new BootstrapInputError('uv 工件 SHA-256 与固定发布值不匹配。');
  }
  const attestation = artifacts.uv.attestation;
  await runCommand(
    'gh',
    [
      'attestation', 'verify', localPath,
      '--repo', attestation.repository,
      '--signer-workflow', attestation.signerWorkflow,
      '--source-digest', attestation.sourceCommit,
      '--source-ref', attestation.sourceRef,
      '--deny-self-hosted-runners',
    ],
    'uv 发布工件没有通过固定 GitHub 证明策略验证。',
  );
}

function runCommand(command: string, arguments_: readonly string[], failure: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { stdio: ['ignore', 'ignore', 'ignore'] });
    child.on('error', () => reject(new BootstrapInputError(failure)));
    child.on('close', (exitCode) => {
      if (exitCode === 0) {
        resolve();
        return;
      }
      reject(new BootstrapInputError(failure));
    });
  });
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk: string | Buffer) => {
      hash.update(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isBootstrapResponse(value: unknown): value is BootstrapResponse {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record['version'] !== 1 || typeof record['state'] !== 'string' || !isBootstrapPlan(record['plan'])) return false;
  if (record['state'] === 'applied') return isBootstrapReadiness(record['readiness']);
  if (record['state'] === 'preview' || record['state'] === 'confirmed') return true;
  return (record['state'] === 'protected-transaction' || record['state'] === 'confirmation-mismatch' || record['state'] === 'prerequisite-refused')
    && typeof record['reason'] === 'string';
}

function isBootstrapPlan(value: unknown): value is BootstrapPlan {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record['transactionDigest'] === 'string'
    && /^[a-f0-9]{64}$/u.test(record['transactionDigest'])
    && Array.isArray(record['transaction'])
    && record['transaction'].every(isTransactionItem)
    && Array.isArray(record['protectedActions'])
    && record['protectedActions'].every(isTransactionItem);
}

function isTransactionItem(value: unknown): value is BootstrapTransactionItem {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record['action'] === 'string' && typeof record['name'] === 'string' && typeof record['nevra'] === 'string';
}

function isBootstrapReadiness(value: unknown): value is BootstrapReadiness {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record['serviceAccount'] === 'ready'
    && typeof record['gccVersion'] === 'string'
    && typeof record['pythonVersion'] === 'string'
    && typeof record['uvVersion'] === 'string'
    && typeof record['buildEnvironmentSha256'] === 'string'
    && /^[a-f0-9]{64}$/u.test(record['buildEnvironmentSha256']);
}
