import { EXTENSION_PAIRING_CODE_TTL_MS, type ExtensionPairing, type ExtensionPairingOutcome } from '@baox/contract';
import type { MockOptions } from './options';

// 扩展配对（mock 服务端角色）：mock 里没有真的浏览器扩展，所以 `?extension=paired` 直接摆出已经配对的样子，
// 不给则还没有配对。生成配对码会让原来的配对失效（与服务端同一条规则），撤销配对回到没有配对。

const PAIRED_AT = '2026-02-01T09:05:00Z';
const LAST_CONNECTED_AT = '2026-02-03T14:20:00Z';
// 固定的一串，e2e 照它断言；真服务端每次随机生成。
const MOCK_CODE = 'K7MQ2PXD';

const NONE: ExtensionPairing = { status: 'none', browser: null, pairedAt: null, lastConnectedAt: null, codeExpiresAt: null, code: null };
const PAIRED: ExtensionPairing = { status: 'paired', browser: 'Chrome 142 · Windows 11', pairedAt: PAIRED_AT, lastConnectedAt: LAST_CONNECTED_AT, codeExpiresAt: null, code: null };

export type ExtensionPairingFlow = {
  getExtensionPairing(): Promise<ExtensionPairing>;
  createExtensionPairingCode(): Promise<ExtensionPairingOutcome>;
  revokeExtensionPairing(): Promise<ExtensionPairingOutcome>;
};

export function createExtensionPairingFlow(options: MockOptions): ExtensionPairingFlow {
  let current: ExtensionPairing = options.extensionPaired ? PAIRED : NONE;
  return {
    getExtensionPairing: async () => current,
    // 那一串只在生成它的这一次出现；之后读配对情况再也带不出来，和服务端一样。
    async createExtensionPairingCode() {
      const codeExpiresAt = new Date(Date.now() + EXTENSION_PAIRING_CODE_TTL_MS).toISOString();
      current = { status: 'waiting', browser: null, pairedAt: null, lastConnectedAt: null, codeExpiresAt, code: null };
      return { ok: true, pairing: { ...current, code: MOCK_CODE } };
    },
    async revokeExtensionPairing() {
      current = NONE;
      return { ok: true, pairing: current };
    },
  };
}
