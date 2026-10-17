import { z } from 'zod';

// The baox 本地执行器 (local executor) as it reaches an employee's PC (ADR-0035): one zip per platform from the settings
// page, holding Node's own signed runtime, the bundled program and a launcher. Installed once by double-clicking the
// launcher, it starts with the employee's login and keeps itself on the program this server ships.

// What the settings page offers. A browser cannot tell an Apple-silicon Mac from an Intel one, so the employee picks.
export const LOCAL_EXECUTOR_PLATFORMS = ['win-x64', 'darwin-arm64', 'darwin-x64'] as const;
export const LocalExecutorPlatformSchema = z.enum(LOCAL_EXECUTOR_PLATFORMS);
export type LocalExecutorPlatform = z.infer<typeof LocalExecutorPlatformSchema>;
export const LOCAL_EXECUTOR_PLATFORM_LABELS: Readonly<Record<LocalExecutorPlatform, string>> = {
  'win-x64': 'Windows',
  'darwin-arm64': 'Mac（Apple 芯片）',
  'darwin-x64': 'Mac（Intel 芯片）',
};

// Behind the session gate: `?platform=<one of the above>`.
export const LOCAL_EXECUTOR_DOWNLOAD_PATH = '/api/local-executor/download';
export const localExecutorDownloadFilename = (platform: LocalExecutorPlatform) => `baox-local-executor-${platform}.zip`;

// The executor's own half, mounted before the session gate and proven by its pairing token (`Authorization: Bearer`):
// what the server ships now, and the program itself.
export const LOCAL_EXECUTOR_RELEASE_PATH = '/api/local-executor/release';
export const LOCAL_EXECUTOR_PROGRAM_PATH = '/api/local-executor/program';

// The program is identified by its bytes (sha256): an executor runs exactly the program its server serves, older or
// newer. `runtime` is the Node version the zips carry; a program for another runtime is not swapped in place.
export const LocalExecutorReleaseSchema = z.object({ program: z.string().regex(/^[0-9a-f]{64}$/), runtime: z.string().min(1) });
export type LocalExecutorRelease = z.infer<typeof LocalExecutorReleaseSchema>;

// Inside every zip, beside the program: the app's address, written by the server that served it (as the extension's
// origin is), so the launcher only has to ask for the 配对码.
export const LOCAL_EXECUTOR_CONFIG_FILE = 'baox-config.json';
export const LocalExecutorConfigSchema = z.object({ origin: z.string().url(), platform: LocalExecutorPlatformSchema });
export type LocalExecutorConfig = z.infer<typeof LocalExecutorConfigSchema>;

export const LOCAL_EXECUTOR_DOWNLOAD_ERRORS = {
  unavailable: '这台服务器上还没有这个系统的本地执行器安装包，请联系管理员。',
  platform: '请选择 Windows 或 Mac 的安装包。',
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
} as const;
