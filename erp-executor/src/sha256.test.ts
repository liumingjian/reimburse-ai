// The browser-safe SHA-256 must be node's SHA-256, byte for byte: approvals the server recorded carry digests made by
// `createHash`, and one differing digest voids every one of them (`approvalCovers`). The digest itself is pinned
// end to end by the kernel golden in server/src/erp/parity.test.ts (`previewDigest`).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from './sha256';

const node = (input: string | Uint8Array) => createHash('sha256').update(input).digest('hex');

describe('sha256Hex', () => {
  it.each([
    ['empty', ''],
    ['one block', 'abc'],
    ['55 bytes, the longest single padded block', 'a'.repeat(55)],
    ['56 bytes, which spills the length into a second block', 'a'.repeat(56)],
    ['64 bytes', 'b'.repeat(64)],
    ['multi-block Chinese text', '费用报销单-新增 发票无忧助手 收票单号 '.repeat(40)],
  ])('matches node for %s', (_name, input) => {
    expect(sha256Hex(input)).toBe(node(input));
  });

  it('hashes raw bytes as node does', () => {
    const bytes = Uint8Array.from({ length: 1000 }, (_, i) => (i * 37) % 256);
    expect(sha256Hex(bytes)).toBe(node(bytes));
  });
});
