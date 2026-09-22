import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createSourceRepository } from './source.js';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const operatorDirectory = fileURLToPath(new URL('./', import.meta.url));

it('archives the full committed repository identically from the root and nested operator directory', async () => {
  const fromRoot = await createSourceRepository(repositoryRoot).archive('HEAD');
  const fromNestedDirectory = await createSourceRepository(operatorDirectory).archive('HEAD');

  expect(fromNestedDirectory.plan).toMatchObject({
    commit: fromRoot.plan.commit,
    archiveSha256: fromRoot.plan.archiveSha256,
  });
  expect(fromNestedDirectory.archive).toEqual(fromRoot.archive);

  const entries = execFileSync('tar', ['-tf', '-'], { input: fromNestedDirectory.archive, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).split('\n');
  expect(entries).toContain('package.json');
  expect(entries).toContain('deploy/operator/package.json');
  expect(entries).toContain('server/package.json');
}, 60_000);

it('runs the documented pnpm entrypoint without a separator and preserves the root archive', () => {
  const stdout = execFileSync('pnpm', ['--filter', '@baox/operator', 'operator', 'plan', '--json'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const output = JSON.parse(stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1) || '{}') as { command?: string; source?: { commit?: string; archiveSha256?: string } };
  const expected = createHash('sha256').update(execFileSync('git', ['archive', '--format=tar', output.source?.commit ?? 'invalid'], {
    cwd: repositoryRoot,
    maxBuffer: 128 * 1024 * 1024,
    timeout: 60_000,
  })).digest('hex');

  expect(output).toMatchObject({ command: 'plan', source: { archiveSha256: expected } });
}, 60_000);
