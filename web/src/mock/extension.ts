import { EXTENSION_PAIRING_CODE_TTL_MS, EXTENSION_VERSION, type ExtensionPairing, type ExtensionPairingOutcome } from '@baox/contract';
import type { MockOptions } from './options';

// 扩展配对 (extension pairing) as the mock server plays it. There is no real 浏览器扩展 (browser extension) in the
// mock, so `?extension=paired` starts out paired and anything else starts unpaired. Issuing a 配对码 (pairing code)
// voids the old pairing (the server's rule), and revoking returns to no pairing.

const PAIRED_AT = '2026-02-01T09:05:00Z';
const LAST_CONNECTED_AT = '2026-02-03T14:20:00Z';
// A fixed code for e2e to assert on; the real server generates a random one each time.
const MOCK_CODE = 'K7MQ2PXD';

const NONE: ExtensionPairing = { status: 'none', browser: null, pairedAt: null, lastConnectedAt: null, codeExpiresAt: null, connected: false, version: null, code: null };
// Paired counts as connected in the mock: there is no extension to connect, and connected is the normal paired state.
const PAIRED: ExtensionPairing = { status: 'paired', browser: 'Chrome 142 · Windows 11', pairedAt: PAIRED_AT, lastConnectedAt: LAST_CONNECTED_AT, codeExpiresAt: null, connected: true, version: EXTENSION_VERSION, code: null };

export type ExtensionPairingFlow = {
  getExtensionPairing(): Promise<ExtensionPairing>;
  createExtensionPairingCode(): Promise<ExtensionPairingOutcome>;
  revokeExtensionPairing(): Promise<ExtensionPairingOutcome>;
};

export function createExtensionPairingFlow(options: MockOptions): ExtensionPairingFlow {
  let current: ExtensionPairing = options.extensionPaired ? PAIRED : NONE;
  return {
    getExtensionPairing: async () => current,
    // The code appears only in the answer that issued it; no later read returns it, as on the server.
    async createExtensionPairingCode() {
      const codeExpiresAt = new Date(Date.now() + EXTENSION_PAIRING_CODE_TTL_MS).toISOString();
      current = { status: 'waiting', browser: null, pairedAt: null, lastConnectedAt: null, codeExpiresAt, connected: false, version: null, code: null };
      return { ok: true, pairing: { ...current, code: MOCK_CODE } };
    },
    async revokeExtensionPairing() {
      current = NONE;
      return { ok: true, pairing: current };
    },
  };
}
