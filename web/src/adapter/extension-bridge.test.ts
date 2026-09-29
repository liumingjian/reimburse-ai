import { EXTENSION_BRIDGE_NAMESPACE } from '@baox/contract';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createWindowBridge } from './extension-bridge';

// The page's half of the page bridge (#290) over a real jsdom window. The extension's answers are dispatched by hand,
// with the origin and source a content script's `postMessage` carries, because jsdom does not fill them in.

const presence = { namespace: EXTENSION_BRIDGE_NAMESPACE, kind: 'presence', version: '1.1.0', paired: true, accountId: 'A1' };

const answer = (data: unknown, init: { origin?: string; source?: Window | null } = {}) =>
  window.dispatchEvent(new MessageEvent('message', { data, origin: init.origin ?? window.location.origin, source: init.source === undefined ? window : init.source }));

afterEach(() => vi.useRealTimers());

describe('the page bridge, from the page', () => {
  test('posts a namespaced probe to its own origin and resolves with the presence that answers it', async () => {
    const posted = vi.spyOn(window, 'postMessage');
    const probing = createWindowBridge({ timeoutMs: 1_000 }).probe();
    expect(posted).toHaveBeenCalledWith({ namespace: EXTENSION_BRIDGE_NAMESPACE, kind: 'probe' }, window.location.origin);
    posted.mockRestore();

    answer(presence);
    await expect(probing).resolves.toEqual({ version: '1.1.0', paired: true, accountId: 'A1' });
  });

  test('reads silence as no extension', async () => {
    vi.useFakeTimers();
    const probing = createWindowBridge({ timeoutMs: 1_000 }).probe();
    vi.advanceTimersByTime(1_000);
    await expect(probing).resolves.toBeNull();
  });

  test('ignores answers from another origin, another window, or without the namespace tag', async () => {
    vi.useFakeTimers();
    const probing = createWindowBridge({ timeoutMs: 1_000 }).probe();
    answer(presence, { origin: 'https://evil.example' });
    answer(presence, { source: null });
    answer({ ...presence, namespace: 'someone-else' });
    answer({ ...presence, namespace: undefined });
    vi.advanceTimersByTime(1_000);
    await expect(probing).resolves.toBeNull();
  });

  // #291: the pair outcome is the answer, not the presence the content script may announce meanwhile.
  test('hands over a 配对码 and resolves with the pair outcome that answers it', async () => {
    const posted = vi.spyOn(window, 'postMessage');
    const pairing = createWindowBridge({ pairTimeoutMs: 1_000 }).pair('K7MQ2PXD');
    expect(posted).toHaveBeenCalledWith({ namespace: EXTENSION_BRIDGE_NAMESPACE, kind: 'pair', code: 'K7MQ2PXD' }, window.location.origin);
    posted.mockRestore();

    answer(presence);
    answer({ namespace: EXTENSION_BRIDGE_NAMESPACE, kind: 'pair_outcome', outcome: { status: 'failed', code: 'version_too_old', message: '请升级' } });
    await expect(pairing).resolves.toEqual({ status: 'failed', code: 'version_too_old', message: '请升级' });
  });

  test('reads a pair request nobody answers as no extension', async () => {
    vi.useFakeTimers();
    const pairing = createWindowBridge({ pairTimeoutMs: 1_000 }).pair('K7MQ2PXD');
    answer({ namespace: EXTENSION_BRIDGE_NAMESPACE, kind: 'pair_outcome', outcome: { status: 'paired', accountId: 'A1' } }, { origin: 'https://evil.example' });
    vi.advanceTimersByTime(1_000);
    await expect(pairing).resolves.toBeNull();
  });
});
