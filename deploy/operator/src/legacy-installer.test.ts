import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const legacyInstaller = fileURLToPath(new URL('../../intranet/install.sh', import.meta.url));

it('retires the direct installer before it reads inputs or changes a host', () => {
  const result = spawnSync('bash', [legacyInstaller], { encoding: 'utf8' });

  expect(result.status).toBe(64);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('install.sh is retired');
  expect(result.stderr).toContain('makes no host changes');
});
