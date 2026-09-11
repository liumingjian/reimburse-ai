import test from 'node:test';
import assert from 'node:assert/strict';

import { lookupNetworkLocation, normalizeIpLocation, IP_LOCATION_URL } from '../src/location.mjs';

test('网络位置 Adapter 只接收完整的城市级位置', () => {
  assert.deepEqual(normalizeIpLocation({
    city: '北京市', latitude: 39.9042, longitude: 116.4074,
  }), {
    city: '北京市', latitude: 39.9042, longitude: 116.4074,
    source: 'ip', precision: 'city',
  });
  assert.equal(normalizeIpLocation({ city: '北京市', latitude: 91, longitude: 116 }), null);
  assert.equal(normalizeIpLocation({ city: 'unknown', latitude: 0, longitude: 0 }), null);
  assert.equal(normalizeIpLocation({ city: '北京市', latitude: 39.9 }), null);
});

test('网络位置 Adapter 使用固定 HTTPS endpoint，失败时返回空候选', async () => {
  assert.equal(IP_LOCATION_URL, 'https://ipwho.is/');
  const calls = [];
  const location = await lookupNetworkLocation({
    command: 'fake-curl',
    execFileFn: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: JSON.stringify({ success: true, city: '广州市',
        latitude: 23.1291, longitude: 113.2644 }) };
    },
  });

  assert.deepEqual(location, {
    city: '广州市', latitude: 23.1291, longitude: 113.2644,
    source: 'ip', precision: 'city',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'fake-curl');
  assert.equal(calls[0].args.at(-1), IP_LOCATION_URL);
  assert.ok(calls[0].args.includes('--fail'));
  assert.ok(calls[0].args.includes('--max-time'));
  assert.deepEqual(calls[0].args.slice(calls[0].args.indexOf('--noproxy'),
    calls[0].args.indexOf('--noproxy') + 2), ['--noproxy', '*']);

  const failed = await lookupNetworkLocation({
    execFileFn: async () => { throw new Error('network unavailable'); },
  });
  assert.equal(failed, null);
});
