import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCAL_EXECUTOR_RUNTIME_ERRORS, localExecutorRuntimePath, localExecutorRuntimeSha256Path } from '@baox/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestServer, type TestServer } from '../test/harness';
import type { LocalExecutorDist } from './package';

// The Node runtime the install script and the 本地执行器 download when the PC has no usable Node (ADR-0035), at the
// HTTP seam, over a runtime cache laid out the way the deploy leaves it (`local-executor/scripts/fetch-runtimes.mjs`):
// `<version>/<platform>/node[.exe]` beside `node[.exe].sha256`, and `VERSION` naming the version served.

const PLATFORMS = [['win-x64', 'node.exe'], ['darwin-arm64', 'node'], ['darwin-x64', 'node']] as const;
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
let workDir: string;
let dist: LocalExecutorDist;
let server: TestServer;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'baox-local-executor-runtime-'));
  dist = { program: join(workDir, 'dist', 'baox-local-executor.mjs'), runtimes: join(workDir, 'runtime') };
  mkdirSync(join(workDir, 'dist'), { recursive: true });
  writeFileSync(dist.program, 'console.log("baox");\n');
  for (const [platform, binary] of PLATFORMS) {
    const dir = join(dist.runtimes, '24.21.0', platform);
    mkdirSync(dir, { recursive: true });
    const bytes = Buffer.from(`runtime for ${platform}\n`.repeat(1000));
    writeFileSync(join(dir, binary), bytes);
    writeFileSync(join(dir, `${binary}.sha256`), `${sha256(bytes)}\n`);
  }
  writeFileSync(join(dist.runtimes, 'VERSION'), '24.21.0\n');
  server = await createTestServer({ localExecutor: dist });
});
afterEach(async () => {
  await server.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe('the runtime download', () => {
  it.each(PLATFORMS.map(([platform]) => platform))('serves the %s runtime without a login, and it hashes to the sha256 served beside it', async (platform) => {
    const runtime = await server.app.request(localExecutorRuntimePath(platform));
    expect(runtime.status).toBe(200);
    expect(runtime.headers.get('content-type')).toBe('application/octet-stream');
    const bytes = Buffer.from(await runtime.arrayBuffer());
    expect(bytes.toString('utf8')).toContain(`runtime for ${platform}`);
    expect(runtime.headers.get('content-length')).toBe(String(bytes.length));

    const sum = await server.app.request(localExecutorRuntimeSha256Path(platform));
    expect(sum.status).toBe(200);
    expect(sum.headers.get('content-type')).toContain('text/plain');
    expect(await sum.text()).toBe(`${sha256(bytes)}\n`);
  });

  it('refuses a platform it does not serve', async () => {
    for (const path of [localExecutorRuntimePath('linux-x64'), localExecutorRuntimeSha256Path('linux-x64')]) {
      const answer = await server.app.request(path);
      expect(answer.status, path).toBe(404);
      expect(await answer.json()).toMatchObject({ error: { code: 'platform_invalid', message: LOCAL_EXECUTOR_RUNTIME_ERRORS.platform } });
    }
  });

  it('serves nothing for a runtime whose sha256 the deploy never recorded', async () => {
    rmSync(join(dist.runtimes, '24.21.0', 'darwin-x64', 'node.sha256'));
    for (const path of [localExecutorRuntimePath('darwin-x64'), localExecutorRuntimeSha256Path('darwin-x64')]) {
      const answer = await server.app.request(path);
      expect(answer.status, path).toBe(503);
      expect(await answer.json()).toMatchObject({ error: { code: 'local_executor_unavailable', message: LOCAL_EXECUTOR_RUNTIME_ERRORS.unavailable } });
    }
  });

  it('serves nothing when no runtime was ever fetched', async () => {
    rmSync(join(dist.runtimes, 'VERSION'));
    expect((await server.app.request(localExecutorRuntimePath('win-x64'))).status).toBe(503);
  });
});
