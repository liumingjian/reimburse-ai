import { PAIRING_PATH, CLIENT_VERSION } from '@baox/contract';
import { describe, expect, it } from 'vitest';
import { redeemPairingCode, revokePairing } from './pairing';

const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('redeeming the 配对码 the employee typed', () => {
  it('posts the code and this 本地执行器 version to the address baked into the build', async () => {
    let seen: { url: string; body: unknown } | null = null;
    const outcome = await redeemPairingCode({
      origin: 'http://10.250.0.222',
      code: 'k7mq-2pxd',
      browser: 'Chrome 142 Windows',
      fetchImpl: async (url, init) => {
        seen = { url: String(url), body: JSON.parse(String(init?.body)) as unknown };
        return jsonResponse(200, { token: 'tok', accountId: 'a1' });
      },
    });

    expect(seen).toEqual({ url: `http://10.250.0.222${PAIRING_PATH}`, body: { code: 'k7mq-2pxd', browser: 'Chrome 142 Windows', version: CLIENT_VERSION } });
    expect(outcome).toEqual({ ok: true, token: 'tok', accountId: 'a1' });
  });

  it('shows the upgrade instructions the server sent rather than a refusal of its own', async () => {
    const outcome = await redeemPairingCode({
      origin: 'http://10.250.0.222',
      code: 'K7MQ2PXD',
      fetchImpl: async () => jsonResponse(403, { error: { code: 'version_too_old', message: '这台服务器要求 baox 本地执行器 2.0.0 或更新的版本，请回到设置页生成安装命令。' } }),
    });

    expect(outcome).toEqual({ ok: false, code: 'version_too_old', message: '这台服务器要求 baox 本地执行器 2.0.0 或更新的版本，请回到设置页生成安装命令。' });
  });

  it('says the app is unreachable rather than that the code was wrong', async () => {
    const outcome = await redeemPairingCode({
      origin: 'http://10.250.0.222',
      code: 'K7MQ2PXD',
      fetchImpl: () => Promise.reject(new Error('connect ECONNREFUSED')),
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.code).toBe('network_error');
  });
});

describe('撤销配对 from the 本地执行器', () => {
  it('revokes on the app with the token being given up, so the pairing does not outlive this browser', async () => {
    let seen: { url: string; method: string | undefined; authorization: string | null } | null = null;
    const revoked = await revokePairing({
      origin: 'http://10.250.0.222',
      token: 'tok',
      fetchImpl: async (url, init) => {
        seen = { url: String(url), method: init?.method, authorization: new Headers(init?.headers).get('authorization') };
        return jsonResponse(200, { revoked: true });
      },
    });

    expect(seen).toEqual({ url: `http://10.250.0.222${PAIRING_PATH}`, method: 'DELETE', authorization: 'Bearer tok' });
    expect(revoked).toBe(true);
  });

  it('counts a pairing the app no longer knows as revoked, and an unreachable app as not', async () => {
    expect(await revokePairing({ origin: 'http://10.250.0.222', token: 'tok', fetchImpl: async () => jsonResponse(401, { error: { code: 'not_paired', message: '' } }) })).toBe(true);
    expect(await revokePairing({ origin: 'http://10.250.0.222', token: 'tok', fetchImpl: () => Promise.reject(new Error('connect ECONNREFUSED')) })).toBe(false);
  });
});
