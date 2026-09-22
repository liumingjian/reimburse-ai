import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { runOperatorCli } from './cli.js';
import type { SourceRepository } from './source.js';
import { IsolatedBootstrapTarget } from './testing/isolated-bootstrap-target.js';

const targets: IsolatedBootstrapTarget[] = [];

afterEach(() => {
  for (const target of targets.splice(0)) target.dispose();
});

function target(options: ConstructorParameters<typeof IsolatedBootstrapTarget>[0] = {}): IsolatedBootstrapTarget {
  const result = new IsolatedBootstrapTarget(options);
  targets.push(result);
  return result;
}

const unusedSource: SourceRepository = {
  plan: async () => {
    throw new Error('bootstrap does not select application source');
  },
  archive: async () => {
    throw new Error('bootstrap does not archive application source');
  },
};

async function cli(host: IsolatedBootstrapTarget, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runOperatorCli(
    argv,
    { source: unusedSource, host: host.host, bootstrapProvenance: async () => undefined },
    { out: (line) => out.push(line), err: (line) => err.push(line) },
  );
  return { code, out: out.join('\n'), err: err.join('\n') };
}

it('does not reach the target or stage artifacts when bootstrap apply lacks a reviewed digest', async () => {
  const isolated = target();

  const result = await cli(isolated, 'bootstrap-apply', '--proxy', 'http://proxy.example.test:7890');

  expect(result.code).toBe(2);
  expect(isolated.remoteCommands).toEqual([]);
  expect(isolated.appliedPackageTransaction).toBe(false);
  expect(isolated.createdServiceAccount).toBe(false);
});

it('applies a reviewed direct transaction through the real host driver without host-wide paths', async () => {
  const isolated = target();

  const preview = await cli(isolated, 'bootstrap-preview', '--proxy', 'http://proxy.example.test:7890', '--json');
  const previewValue = JSON.parse(preview.out) as { response: { plan: { transactionDigest: string } } };
  const applied = await cli(
    isolated,
    'bootstrap-apply', '--confirm', previewValue.response.plan.transactionDigest,
    '--proxy', 'http://proxy.example.test:7890', '--json',
  );

  expect(preview.code).toBe(0);
  expect(applied.code).toBe(0);
  expect(isolated.appliedPackageTransaction).toBe(true);
  expect(isolated.createdServiceAccount).toBe(true);
  expect(isolated.verifiedGccSignature).toBe(true);
  expect(existsSync(`${isolated.profile.deployRoot}/runtime/gcc-12.5.0/bin/g++`)).toBe(true);
  expect(existsSync(`${isolated.profile.serviceHome}/.local/share/baox-build-venv/bin/python`)).toBe(true);
  expect(readFileSync(isolated.profile.buildEnvironment, 'utf8')).toContain('HTTP_PROXY=http://proxy.example.test:7890');
  expect(isolated.proxyCalls).toEqual(expect.arrayContaining([expect.stringContaining('--proxy http://proxy.example.test:7890')]));
  expect(isolated.remoteCommands.join('\n')).not.toContain('/opt/tools/baox');
  expect(isolated.remoteCommands.join('\n')).not.toMatch(/(^|[^A-Za-z0-9._-])\/home\/baox(?:\/|['\s])/u);
});

it('refuses a package transaction that would replace a protected system runtime', async () => {
  const isolated = target({ transaction: [{ action: 'upgrade', name: 'glibc', nevra: 'glibc-2.28-300.ky10.x86_64' }] });
  const preview = await isolated.host.execute({ kind: 'bootstrap-preview', source: { kind: 'proxy', proxy: 'http://proxy.example.test:7890' } });

  expect(preview.kind).toBe('bootstrap-preview');
  if (preview.kind !== 'bootstrap-preview') throw new Error('unexpected bootstrap preview response');
  const applied = await isolated.host.execute({
    kind: 'bootstrap-apply',
    source: { kind: 'proxy', proxy: 'http://proxy.example.test:7890' },
    confirmationDigest: preview.value.plan.transactionDigest,
  });

  expect(applied).toMatchObject({ kind: 'bootstrap-apply', value: { state: 'protected-transaction' } });
  expect(isolated.appliedPackageTransaction).toBe(false);
  expect(isolated.createdServiceAccount).toBe(false);
  expect(existsSync(isolated.profile.buildEnvironment)).toBe(false);
});

it('rechecks relay bytes on the target before the package transaction can apply', async () => {
  const isolated = target();
  for (const artifact of isolated.localArtifacts()) await isolated.host.uploadArtifact(artifact);
  writeFileSync(isolated.relayPath(isolated.artifacts.python.sha256), 'tampered after upload');
  const preview = await isolated.host.execute({ kind: 'bootstrap-preview', source: { kind: 'relay', proxy: 'http://proxy.example.test:7890' } });

  expect(preview.kind).toBe('bootstrap-preview');
  if (preview.kind !== 'bootstrap-preview') throw new Error('unexpected bootstrap preview response');
  await expect(isolated.host.execute({
    kind: 'bootstrap-apply',
    source: { kind: 'relay', proxy: 'http://proxy.example.test:7890' },
    confirmationDigest: preview.value.plan.transactionDigest,
  })).rejects.toThrow('bootstrap');

  expect(isolated.appliedPackageTransaction).toBe(false);
  expect(isolated.createdServiceAccount).toBe(false);
});
