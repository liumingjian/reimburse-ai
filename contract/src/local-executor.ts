import { z } from 'zod';

// The baox 本地执行器 (local executor) as it reaches an employee's PC (ADR-0035, amended 2026-10-17): the 设置页 shows
// one command, pasted into Terminal or PowerShell, that installs it (LOCAL_EXECUTOR_INSTALL_PATH below). It then starts
// with the employee's login and keeps itself on the program this server ships. There is no install package any more;
// an executor installed from the old zip keeps working and takes each new program by self-update.

// The platforms the server caches Node's own runtime for. The install script tells them apart by itself.
export const LOCAL_EXECUTOR_PLATFORMS = ['win-x64', 'darwin-arm64', 'darwin-x64'] as const;
export const LocalExecutorPlatformSchema = z.enum(LOCAL_EXECUTOR_PLATFORMS);
export type LocalExecutorPlatform = z.infer<typeof LocalExecutorPlatformSchema>;

// The executor's own half, mounted before the session gate and proven by its pairing token (`Authorization: Bearer`):
// what the server ships now, and the program itself.
export const LOCAL_EXECUTOR_RELEASE_PATH = '/api/local-executor/release';
export const LOCAL_EXECUTOR_PROGRAM_PATH = '/api/local-executor/program';

// Before the session gate and open to anyone, since the install script runs before any pairing: Node's own runtime for
// a platform, for a PC without a usable Node of its own, and beside it that binary's sha256 as one line of hex (the
// script and the executor check the download against it). An unknown platform is 404, a runtime the deploy has not
// fetched 503.
export const LOCAL_EXECUTOR_RUNTIME_PATH = '/api/local-executor/runtime';
export const localExecutorRuntimePath = (platform: string) => `${LOCAL_EXECUTOR_RUNTIME_PATH}/${platform}`;
export const localExecutorRuntimeSha256Path = (platform: string) => `${LOCAL_EXECUTOR_RUNTIME_PATH}/${platform}/sha256`;

// The program is identified by its bytes (sha256): an executor runs exactly the program its server serves, older or
// newer. `runtime` is the Node version the server caches; an executor compares only its major version (ADR-0035): a
// minor change is ignored, a major change switches it to the runtime downloaded from the server.
export const LocalExecutorReleaseSchema = z.object({ program: z.string().regex(/^[0-9a-f]{64}$/), runtime: z.string().min(1) });
export type LocalExecutorRelease = z.infer<typeof LocalExecutorReleaseSchema>;

// Beside the installed program: the app's address, written by the install script's last step (a zip install had it
// from the zip). `node` is the absolute path of the Node the executor runs
// on, which its start-at-login entry runs (ADR-0035, amended 2026-10-16): the employee's own Node 24, or the runtime
// downloaded into the executor's `app/runtime`. A zip install recorded none; it runs on the runtime beside it.
export const LOCAL_EXECUTOR_CONFIG_FILE = 'baox-config.json';
export const LocalExecutorConfigSchema = z.object({ origin: z.string().url(), platform: LocalExecutorPlatformSchema, node: z.string().min(1).optional() });
export type LocalExecutorConfig = z.infer<typeof LocalExecutorConfigSchema>;

// The executor's own routes (release, program) when this server has no program or runtime to ship.
export const LOCAL_EXECUTOR_RELEASE_ERRORS = {
  unavailable: '这台服务器上还没有本地执行器，请联系管理员。',
} as const;

// The running executor's own loopback listener on the employee's PC (ADR-0035): it holds the one-per-PC slot, and it
// answers the app's own page only (its `Origin`), never another site. The 设置页 reads which 应用账号 it is paired to
// (`GET`) and hands it a fresh 配对码 (`POST { code }`), which it redeems exactly as the install does.
export const LOCAL_EXECUTOR_PORT = 47319;
export const LOCAL_EXECUTOR_LOOPBACK_ORIGIN = `http://127.0.0.1:${LOCAL_EXECUTOR_PORT}`;
export const LOCAL_EXECUTOR_PAIRING_PATH = '/pairing';
export const LocalExecutorPairingStateSchema = z.discriminatedUnion('paired', [
  z.object({ paired: z.literal(true), accountId: z.string().min(1) }),
  z.object({ paired: z.literal(false) }),
]);
export type LocalExecutorPairingState = z.infer<typeof LocalExecutorPairingStateSchema>;
export const LocalExecutorPairRequestSchema = z.object({ code: z.string().trim().min(1).max(64) });
export type LocalExecutorPairRequest = z.infer<typeof LocalExecutorPairRequestSchema>;
export const LocalExecutorPairAnswerSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), accountId: z.string().min(1) }),
  z.object({ ok: z.literal(false), code: z.string().min(1), message: z.string().min(1) }),
]);
export type LocalExecutorPairAnswer = z.infer<typeof LocalExecutorPairAnswerSchema>;
export const LOCAL_EXECUTOR_PAIRING_ERRORS = {
  busy: '这台电脑上的 baox 本地执行器正在去报销，请等它做完再连接。',
  pairing: '这台电脑上的 baox 本地执行器正在配对，请稍后再试。',
  request: '请求里没有配对码。',
  // Anything else that went wrong on the executor (it keeps the error in its own log).
  failed: '这台电脑上的 baox 本地执行器没能完成配对，请再点一次。',
} as const;
export const LOCAL_EXECUTOR_RUNTIME_ERRORS = {
  unavailable: '这台服务器上还没有这个系统的运行环境，请联系管理员。',
  platform: '没有这个系统的运行环境，只有 Windows 和 Mac 的。',
} as const;

// One command installs the 本地执行器 (spec #412 part C, ADR-0035 amended 2026-10-17). The employee picks the system
// on the 设置页 when generating the 配对码; the code is stored with that choice, and the public install route answers
// the script for it:
//
//   Mac      curl -fsSL <应用地址>/install/<配对码> | sh
//   Windows  powershell -ExecutionPolicy Bypass -c "irm <应用地址>/install/<配对码> | iex"
//
// Fetching the script does not spend the code; pairing does. The script and the program it downloads are served for
// the code's ten minutes, paired or not, so a run cut off after pairing can be run again. Any other code answers a
// script that prints LOCAL_EXECUTOR_INSTALL_MESSAGES.expired and exits non-zero, so `curl -f` never shows an English
// error. Uninstalling needs no code.
export const INSTALL_SYSTEMS = ['mac', 'windows'] as const;
export const InstallSystemSchema = z.enum(INSTALL_SYSTEMS);
export type InstallSystem = z.infer<typeof InstallSystemSchema>;
export const CreatePairingCodeInputSchema = z.object({ system: InstallSystemSchema.optional() });
export type CreatePairingCodeInput = z.infer<typeof CreatePairingCodeInputSchema>;

export const LOCAL_EXECUTOR_INSTALL_PATH = '/install';
export const localExecutorInstallPath = (code: string) => `${LOCAL_EXECUTOR_INSTALL_PATH}/${code}`;
export const localExecutorInstallProgramPath = (code: string) => `${LOCAL_EXECUTOR_INSTALL_PATH}/${code}/program`;
export const LOCAL_EXECUTOR_UNINSTALL_PATH = '/uninstall';
export const localExecutorUninstallPath = (system: InstallSystem) => `${LOCAL_EXECUTOR_UNINSTALL_PATH}/${system}`;

// The command the 设置页 shows, for the address the server admits (`PairingView.activeOrigin`).
const pasteCommand = (system: InstallSystem, url: string) => (system === 'windows' ? `powershell -ExecutionPolicy Bypass -c "irm ${url} | iex"` : `curl -fsSL ${url} | sh`);
export const localExecutorInstallCommand = (system: InstallSystem, origin: string, code: string) => pasteCommand(system, `${origin.replace(/\/+$/, '')}${localExecutorInstallPath(code)}`);
// The uninstall command the 设置页 shows under 「安装遇到问题？」: the same shape, no 配对码.
export const localExecutorUninstallCommand = (system: InstallSystem, origin: string) => pasteCommand(system, `${origin.replace(/\/+$/, '')}${localExecutorUninstallPath(system)}`);

// Everything the install and uninstall scripts print: these lines and nothing else (story 29, 30).
export const LOCAL_EXECUTOR_INSTALL_MESSAGES = {
  checking: '检查运行环境',
  downloading: (percent: number) => `下载运行环境 ${percent}%`,
  pairing: '配对',
  installed: '已安装，可以关掉这个窗口',
  uninstalled: '已卸载，可以关掉这个窗口',
  expired: '配对码已过期，请回设置页重新生成',
  wrongSystem: '这条命令只能在 Mac 上运行，请回设置页选择你的系统',
  wrongSystemWindows: '这条命令只能在 Windows 上运行，请回设置页选择你的系统',
  unreachable: '连不上应用，请检查网络后再运行一次这条命令',
  unavailable: '应用服务器上还没有本地执行器，请联系管理员',
  download: '运行环境没有下载完整，请再运行一次这条命令',
  disk: '没能写入你的用户目录，请确认磁盘还有空间后再运行一次这条命令',
  start: '已安装，但没能马上启动，请退出登录再登录一次电脑',
  failed: '安装没有完成，请再运行一次这条命令',
} as const;

// How the program's install step (`finish-install`, local-executor/src/main.ts) tells the script what went wrong; the
// script prints the sentence for it.
export const LOCAL_EXECUTOR_INSTALL_EXIT = { expired: 10, unreachable: 11, start: 12 } as const;

// Node.js's own Developer ID (checked 2026-10-15): "Developer ID Application: Node.js Foundation (HX7739G8FX)". Both the
// install script and the executor's start check the employee's Node against it on macOS (ADR-0035).
export const NODE_SIGNER_TEAM = 'HX7739G8FX';
export const NODE_SIGNATURE_REQUIREMENT = `=anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = ${NODE_SIGNER_TEAM}`;

// Variables that make Node load code the program did not bring, or trust a certificate the system does not: cleared
// at every start, so a PC's Node setup cannot reach the 报销系统 password the executor holds (story 26). The app's
// private CA is trusted through the system store (`--use-system-ca`, ADR-0036), so NODE_EXTRA_CA_CERTS is not needed.
export const CODE_LOADING_ENV = [
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_REPL_EXTERNAL_MODULE',
  'NODE_EXTRA_CA_CERTS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
] as const;
