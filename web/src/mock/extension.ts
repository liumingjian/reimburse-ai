import { EXTENSION_PAIRING_CODE_TTL_MS, EXTENSION_PAIRING_ERRORS, EXTENSION_VERSION, type CreatePairingCodeInput, type ExtensionHolder, type ExtensionPairing, type ExtensionPairingOutcome, type LocalExecutorPairingState } from '@baox/contract';
import type { LocalExecutorPort } from '../adapter/local-executor-port';
import { MOCK_ACCOUNT } from './auth';
import type { MockOptions } from './options';

// 扩展配对 (extension pairing) as the mock server plays it. There is no real 浏览器扩展 (browser extension) in the
// mock, so `?extension=paired` starts out paired and anything else starts unpaired. Issuing a 配对码 (pairing code)
// voids the old pairing (the server's rule), and revoking returns to no pairing.
//
// The mock also plays the 本地执行器 on this PC. A code issued for an install (with a system) pairs by itself a little
// later, as if the employee had pasted the command and the script had finished. `?localExecutor=unpaired|paired|other`
// puts an executor on 47319 (`localExecutor`), unpaired, paired to this account, or to another one; a code handed to it
// pairs at once. Without the option nothing answers there, until an install has paired one. `paired` also starts the
// account's pairing held by the 本地执行器 (`holder`), so the 设置页 opens on that method.

const PAIRED_AT = '2026-02-01T09:05:00Z';
const LAST_CONNECTED_AT = '2026-02-03T14:20:00Z';
// A fixed code for e2e to assert on; the real server generates a random one each time.
const MOCK_CODE = 'K7MQ2PXD';
const DEFAULT_ACTIVE_ORIGIN = 'http://10.250.0.222:8888';
// How long the mock's install command takes to run, from issuing its code to the pairing landing.
const DEFAULT_INSTALL_MS = 4_000;
const OTHER_ACCOUNT_ID = 'A9';
const EXECUTOR_BROWSER = 'baox 本地执行器（darwin）';

const unpaired = (activeOrigin: string): ExtensionPairing => ({ activeOrigin, status: 'none', browser: null, pairedAt: null, lastConnectedAt: null, codeExpiresAt: null, connected: false, version: null, holder: null, code: null });
// Paired counts as connected in the normal mock state: there is no real extension to connect.
const paired = (activeOrigin: string, connected: boolean, holder: ExtensionHolder = 'extension', browser = 'Chrome 142 · Windows 11'): ExtensionPairing => ({ activeOrigin, status: 'paired', browser, pairedAt: PAIRED_AT, lastConnectedAt: LAST_CONNECTED_AT, codeExpiresAt: null, connected, version: EXTENSION_VERSION, holder, code: null });

export type ExtensionPairingFlow = {
  getExtensionPairing(): Promise<ExtensionPairing>;
  createExtensionPairingCode(input?: CreatePairingCodeInput): Promise<ExtensionPairingOutcome>;
  revokeExtensionPairing(): Promise<ExtensionPairingOutcome>;
};

export function createExtensionPairingFlow(options: MockOptions): { flow: ExtensionPairingFlow; localExecutor: LocalExecutorPort } {
  const activeOrigin = options.extensionOrigin ?? DEFAULT_ACTIVE_ORIGIN;
  // An executor paired to this account holds the account's pairing too, unless `?extension=` says the extension does.
  let current: ExtensionPairing = options.extensionPaired
    ? paired(activeOrigin, options.extensionConnected ?? true)
    : options.localExecutor === 'paired'
      ? paired(activeOrigin, true, 'local_executor', EXECUTOR_BROWSER)
      : unpaired(activeOrigin);
  // The executor on this PC: null when none answers on 47319.
  let executor: LocalExecutorPairingState | null = options.localExecutor === undefined
    ? null
    : options.localExecutor === 'unpaired'
      ? { paired: false }
      : { paired: true, accountId: options.localExecutor === 'other' ? OTHER_ACCOUNT_ID : MOCK_ACCOUNT.accountId };
  let installing: ReturnType<typeof setTimeout> | null = null;

  const landExecutorPairing = () => {
    current = paired(activeOrigin, true, 'local_executor', EXECUTOR_BROWSER);
    executor = { paired: true, accountId: MOCK_ACCOUNT.accountId };
  };
  const cancelInstall = () => {
    if (installing !== null) clearTimeout(installing);
    installing = null;
  };

  const flow: ExtensionPairingFlow = {
    getExtensionPairing: async () => current,
    // The code appears only in the answer that issued it; no later read returns it, as on the server.
    async createExtensionPairingCode(input) {
      cancelInstall();
      const codeExpiresAt = new Date(Date.now() + EXTENSION_PAIRING_CODE_TTL_MS).toISOString();
      current = { activeOrigin, status: 'waiting', browser: null, pairedAt: null, lastConnectedAt: null, codeExpiresAt, connected: false, version: null, holder: null, code: null };
      if (input?.system) {
        installing = setTimeout(() => {
          installing = null;
          if (current.status === 'waiting') landExecutorPairing();
        }, options.localExecutorInstallMs ?? DEFAULT_INSTALL_MS);
      }
      return { ok: true, pairing: { ...current, code: MOCK_CODE } };
    },
    async revokeExtensionPairing() {
      cancelInstall();
      current = unpaired(activeOrigin);
      return { ok: true, pairing: current };
    },
  };
  const localExecutor: LocalExecutorPort = {
    probe: async () => executor,
    async pair(code) {
      if (executor === null) return null;
      if (code !== MOCK_CODE || current.status !== 'waiting') return { ok: false, code: 'pairing_code_invalid', message: EXTENSION_PAIRING_ERRORS.codeInvalid };
      cancelInstall();
      landExecutorPairing();
      return { ok: true, accountId: MOCK_ACCOUNT.accountId };
    },
  };
  return { flow, localExecutor };
}
