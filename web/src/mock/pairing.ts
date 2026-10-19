import { PAIRING_CODE_TTL_MS, PAIRING_ERRORS, CLIENT_VERSION, type CreatePairingCodeInput, type PairingView, type PairingChangeOutcome, type LocalExecutorPairingState } from '@baox/contract';
import type { LocalExecutorPort } from '../adapter/local-executor-port';
import { MOCK_ACCOUNT } from './auth';
import type { MockOptions } from './options';

// 配对 (pairing) as the mock server plays it, between the 应用账号 and its 本地执行器 (ADR-0037). The account starts
// paired, so 去报销 runs; `?pairing=none` starts it with nothing paired, and 去报销 is refused (`paired`). Issuing a
// 配对码 (pairing code) voids the old pairing (the server's rule), and revoking returns to no pairing.
//
// The mock also plays the 本地执行器 on this PC. A code issued for an install (with a system) pairs by itself a little
// later, as if the employee had pasted the command and the script had finished. `?localExecutor=unpaired|paired|other`
// puts an executor on 47319 (`localExecutor`), unpaired, paired to this account, or to another one; a code handed to it
// pairs at once. Without the option nothing answers there, until an install has paired one.

const PAIRED_AT = '2026-02-01T09:05:00Z';
const LAST_CONNECTED_AT = '2026-02-03T14:20:00Z';
// A fixed code for e2e to assert on; the real server generates a random one each time.
const MOCK_CODE = 'K7MQ2PXD';
const DEFAULT_ACTIVE_ORIGIN = 'http://10.250.0.222:8888';
// How long the mock's install command takes to run, from issuing its code to the pairing landing.
const DEFAULT_INSTALL_MS = 4_000;
const OTHER_ACCOUNT_ID = 'A9';
const EXECUTOR_BROWSER = 'baox 本地执行器（darwin）';

const unpaired = (activeOrigin: string): PairingView => ({ activeOrigin, status: 'none', browser: null, pairedAt: null, lastConnectedAt: null, codeExpiresAt: null, connected: false, version: null, code: null });
const paired = (activeOrigin: string): PairingView => ({ activeOrigin, status: 'paired', browser: EXECUTOR_BROWSER, pairedAt: PAIRED_AT, lastConnectedAt: LAST_CONNECTED_AT, codeExpiresAt: null, connected: true, version: CLIENT_VERSION, code: null });

export type PairingFlow = {
  getPairing(): Promise<PairingView>;
  createPairingCode(input?: CreatePairingCodeInput): Promise<PairingChangeOutcome>;
  revokePairing(): Promise<PairingChangeOutcome>;
};

export function createPairingFlow(options: MockOptions): { flow: PairingFlow; localExecutor: LocalExecutorPort; paired: () => boolean } {
  const activeOrigin = options.appOrigin ?? DEFAULT_ACTIVE_ORIGIN;
  let current: PairingView = options.pairing === 'none' ? unpaired(activeOrigin) : paired(activeOrigin);
  // The executor on this PC: null when none answers on 47319.
  let executor: LocalExecutorPairingState | null = options.localExecutor === undefined
    ? null
    : options.localExecutor === 'unpaired'
      ? { paired: false }
      : { paired: true, accountId: options.localExecutor === 'other' ? OTHER_ACCOUNT_ID : MOCK_ACCOUNT.accountId };
  let installing: ReturnType<typeof setTimeout> | null = null;

  const landExecutorPairing = () => {
    current = paired(activeOrigin);
    executor = { paired: true, accountId: MOCK_ACCOUNT.accountId };
  };
  const cancelInstall = () => {
    if (installing !== null) clearTimeout(installing);
    installing = null;
  };

  const flow: PairingFlow = {
    getPairing: async () => current,
    // The code appears only in the answer that issued it; no later read returns it, as on the server.
    async createPairingCode(input) {
      cancelInstall();
      const codeExpiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS).toISOString();
      current = { activeOrigin, status: 'waiting', browser: null, pairedAt: null, lastConnectedAt: null, codeExpiresAt, connected: false, version: null, code: null };
      if (input?.system) {
        installing = setTimeout(() => {
          installing = null;
          if (current.status === 'waiting') landExecutorPairing();
        }, options.localExecutorInstallMs ?? DEFAULT_INSTALL_MS);
      }
      return { ok: true, pairing: { ...current, code: MOCK_CODE } };
    },
    async revokePairing() {
      cancelInstall();
      current = unpaired(activeOrigin);
      return { ok: true, pairing: current };
    },
  };
  const localExecutor: LocalExecutorPort = {
    probe: async () => executor,
    async pair(code) {
      if (executor === null) return null;
      if (code !== MOCK_CODE || current.status !== 'waiting') return { ok: false, code: 'pairing_code_invalid', message: PAIRING_ERRORS.codeInvalid };
      cancelInstall();
      landExecutorPairing();
      return { ok: true, accountId: MOCK_ACCOUNT.accountId };
    },
  };
  return { flow, localExecutor, paired: () => current.status === 'paired' };
}
