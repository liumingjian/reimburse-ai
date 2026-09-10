import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { materializeStepArtifacts } from '../src/step-artifacts.mjs';

test('图片字段提取 step 返回前把版本化请求真实落盘', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-step-artifacts-'));
  const requestPath = path.join(dir, 'task', 'image-extraction-request.json');
  const request = { contractVersion: 1, images: [{ materialId: 'm-1', contentHash: 'a'.repeat(64), absPath: '/tmp/a.png' }] };
  const written = materializeStepArtifacts({ step: { kind: 'extract_images', requestPath, request } });
  assert.deepEqual(written, [requestPath]);
  assert.deepEqual(JSON.parse(fs.readFileSync(requestPath, 'utf8')), request);
  assert.equal(fs.statSync(requestPath).mode & 0o777, 0o600);
});

test('其他 step 不产生图片请求文件', () => {
  assert.deepEqual(materializeStepArtifacts({ step: { kind: 'run' } }), []);
});
