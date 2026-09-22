import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { verifyPnpmRegistryProvenance } from './bootstrap.js';
import { runOperatorCli } from './cli.js';
import type { SourceRepository } from './source.js';
import { IsolatedBootstrapTarget } from './testing/isolated-bootstrap-target.js';

const REAL_SUBPROCESS_TIMEOUT_MS = 30_000;
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
}, REAL_SUBPROCESS_TIMEOUT_MS);

it('applies a reviewed direct transaction through the real host driver without host-wide paths', async () => {
  const isolated = target();

  const preview = await cli(isolated, 'bootstrap-preview', '--proxy', 'http://proxy.example.test:7890', '--json');
  const previewValue = JSON.parse(preview.out) as { response: { plan: { transactionDigest: string } } };
  const applied = await cli(
    isolated,
    'bootstrap-apply', '--confirm', previewValue.response.plan.transactionDigest,
    '--proxy', 'http://proxy.example.test:7890', '--json',
  );
  const appliedValue = JSON.parse(applied.out) as { response: { readiness: { pnpmVersion: string } } };

  expect(preview.code).toBe(0);
  expect(applied.code).toBe(0);
  expect(isolated.appliedPackageTransaction).toBe(true);
  expect(isolated.createdServiceAccount).toBe(true);
  expect(isolated.verifiedGccSignature).toBe(true);
  expect(existsSync(`${isolated.profile.deployRoot}/runtime/gcc-12.5.0/bin/g++`)).toBe(true);
  expect(existsSync(`${isolated.profile.deployRoot}/runtime/pnpm-10.17.1/bin/pnpm`)).toBe(true);
  expect(existsSync(`${isolated.profile.serviceHome}/.local/share/baox-build-venv/bin/python`)).toBe(true);
  expect(appliedValue.response.readiness.pnpmVersion).toBe('10.17.1');
  expect(readFileSync(isolated.profile.buildEnvironment, 'utf8')).toContain('HTTP_PROXY=http://proxy.example.test:7890');
  expect(isolated.proxyCalls).toEqual(expect.arrayContaining([expect.stringContaining('--proxy http://proxy.example.test:7890')]));
  expect(isolated.proxyCalls).toEqual(expect.arrayContaining([expect.stringContaining('pnpm-10.17.1.tgz')]));
  expect(isolated.remoteCommands.join('\n')).not.toContain('/opt/tools/baox');
  expect(isolated.remoteCommands.join('\n')).not.toMatch(/(^|[^A-Za-z0-9._-])\/home\/baox(?:\/|['\s])/u);
  expect(isolated.remoteCommands.join('\n')).not.toContain('npm install');
}, REAL_SUBPROCESS_TIMEOUT_MS);

it('requires pnpm bytes to satisfy the pinned registry integrity and signature', async () => {
  const isolated = target();
  const pnpm = isolated.localArtifacts().find((artifact) => artifact.fileName === isolated.artifacts.pnpm.fileName);
  if (!pnpm) throw new Error('fixture does not expose pnpm');

  await expect(verifyPnpmRegistryProvenance(pnpm.localPath, isolated.artifacts.pnpm)).resolves.toBeUndefined();
  await expect(verifyPnpmRegistryProvenance(pnpm.localPath, { ...isolated.artifacts.pnpm, signature: 'AA==' }))
    .rejects.toThrow('pnpm 发布工件没有通过固定 npm registry 签名验证');
  writeFileSync(pnpm.localPath, 'tampered pnpm archive');
  await expect(verifyPnpmRegistryProvenance(pnpm.localPath, isolated.artifacts.pnpm))
    .rejects.toThrow('pnpm 工件 SHA-256 与固定发布值不匹配');
}, REAL_SUBPROCESS_TIMEOUT_MS);

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
}, REAL_SUBPROCESS_TIMEOUT_MS);

it('refuses bootstrap while an active candidate owns the shared deployment lock', async () => {
  const isolated = target();
  const preview = await isolated.host.execute({ kind: 'bootstrap-preview', source: { kind: 'proxy', proxy: 'http://proxy.example.test:7890' } });
  expect(preview.kind).toBe('bootstrap-preview');
  if (preview.kind !== 'bootstrap-preview') throw new Error('unexpected bootstrap preview response');
  isolated.holdDeploymentLock();

  const applied = await isolated.host.execute({
    kind: 'bootstrap-apply',
    source: { kind: 'proxy', proxy: 'http://proxy.example.test:7890' },
    confirmationDigest: preview.value.plan.transactionDigest,
  });

  expect(applied).toMatchObject({ kind: 'bootstrap-apply', value: { state: 'prerequisite-refused' } });
  expect(isolated.appliedPackageTransaction).toBe(false);
  expect(isolated.createdServiceAccount).toBe(false);
  expect(existsSync(isolated.profile.buildEnvironment)).toBe(false);
}, REAL_SUBPROCESS_TIMEOUT_MS);

it('refuses before the package transaction when the bootstrap host lacks a usable make command', async () => {
  const isolated = target({ missingMake: true });
  const preview = await isolated.host.execute({ kind: 'bootstrap-preview', source: { kind: 'proxy', proxy: 'http://proxy.example.test:7890' } });
  expect(preview.kind).toBe('bootstrap-preview');
  if (preview.kind !== 'bootstrap-preview') throw new Error('unexpected bootstrap preview response');

  const applied = await isolated.host.execute({
    kind: 'bootstrap-apply',
    source: { kind: 'proxy', proxy: 'http://proxy.example.test:7890' },
    confirmationDigest: preview.value.plan.transactionDigest,
  });

  expect(applied).toMatchObject({ kind: 'bootstrap-apply', value: { state: 'prerequisite-refused', reason: expect.stringContaining('make') } });
  expect(isolated.appliedPackageTransaction).toBe(false);
  expect(isolated.createdServiceAccount).toBe(false);
}, REAL_SUBPROCESS_TIMEOUT_MS);

it('refuses before the package transaction when the bootstrap host C++ compiler is unusable', async () => {
  const isolated = target({ unusableHostCompiler: true });
  const preview = await isolated.host.execute({ kind: 'bootstrap-preview', source: { kind: 'proxy', proxy: 'http://proxy.example.test:7890' } });
  expect(preview.kind).toBe('bootstrap-preview');
  if (preview.kind !== 'bootstrap-preview') throw new Error('unexpected bootstrap preview response');

  const applied = await isolated.host.execute({
    kind: 'bootstrap-apply',
    source: { kind: 'proxy', proxy: 'http://proxy.example.test:7890' },
    confirmationDigest: preview.value.plan.transactionDigest,
  });

  expect(applied).toMatchObject({ kind: 'bootstrap-apply', value: { state: 'prerequisite-refused', reason: expect.stringContaining('compiler') } });
  expect(isolated.appliedPackageTransaction).toBe(false);
  expect(isolated.createdServiceAccount).toBe(false);
}, REAL_SUBPROCESS_TIMEOUT_MS);

it('leaves a successor deployment lock in place when bootstrap loses its lease', async () => {
  const isolated = target({ fenceBootstrapLock: true });
  const preview = await isolated.host.execute({ kind: 'bootstrap-preview', source: { kind: 'proxy', proxy: 'http://proxy.example.test:7890' } });
  expect(preview.kind).toBe('bootstrap-preview');
  if (preview.kind !== 'bootstrap-preview') throw new Error('unexpected bootstrap preview response');

  const applied = await isolated.host.execute({
    kind: 'bootstrap-apply',
    source: { kind: 'proxy', proxy: 'http://proxy.example.test:7890' },
    confirmationDigest: preview.value.plan.transactionDigest,
  });

  expect(applied).toMatchObject({ kind: 'bootstrap-apply', value: { state: 'prerequisite-refused', reason: expect.stringContaining('lock was lost') } });
  const owner = JSON.parse(readFileSync(`${isolated.profile.deployRoot}/maintenance/deployment.lock/owner.json`, 'utf8')) as { token: string };
  expect(owner.token).toBe('f'.repeat(64));
}, REAL_SUBPROCESS_TIMEOUT_MS);

it('does not replace a partial compiler runtime while an active release exists', async () => {
  const isolated = target({ activeRelease: true });
  const prefix = `${isolated.profile.deployRoot}/runtime/gcc-12.5.0`;
  mkdirSync(prefix, { recursive: true });
  const preview = await isolated.host.execute({ kind: 'bootstrap-preview', source: { kind: 'proxy', proxy: 'http://proxy.example.test:7890' } });
  expect(preview.kind).toBe('bootstrap-preview');
  if (preview.kind !== 'bootstrap-preview') throw new Error('unexpected bootstrap preview response');

  const applied = await isolated.host.execute({
    kind: 'bootstrap-apply',
    source: { kind: 'proxy', proxy: 'http://proxy.example.test:7890' },
    confirmationDigest: preview.value.plan.transactionDigest,
  });

  expect(applied).toMatchObject({ kind: 'bootstrap-apply', value: { state: 'prerequisite-refused', reason: expect.stringContaining('will not replace') } });
  expect(existsSync(prefix)).toBe(true);
  expect(isolated.appliedPackageTransaction).toBe(false);
}, REAL_SUBPROCESS_TIMEOUT_MS);

it('does not replace a partial pnpm runtime while an active release exists', async () => {
  const isolated = target({ activeRelease: true });
  const prefix = `${isolated.profile.deployRoot}/runtime/pnpm-10.17.1`;
  mkdirSync(prefix, { recursive: true });
  const preview = await isolated.host.execute({ kind: 'bootstrap-preview', source: { kind: 'proxy', proxy: 'http://proxy.example.test:7890' } });
  expect(preview.kind).toBe('bootstrap-preview');
  if (preview.kind !== 'bootstrap-preview') throw new Error('unexpected bootstrap preview response');

  const applied = await isolated.host.execute({
    kind: 'bootstrap-apply',
    source: { kind: 'proxy', proxy: 'http://proxy.example.test:7890' },
    confirmationDigest: preview.value.plan.transactionDigest,
  });

  expect(applied).toMatchObject({ kind: 'bootstrap-apply', value: { state: 'prerequisite-refused', reason: expect.stringContaining('pnpm runtime') } });
  expect(existsSync(prefix)).toBe(true);
  expect(isolated.appliedPackageTransaction).toBe(false);
}, REAL_SUBPROCESS_TIMEOUT_MS);

it('fails readiness when the build Python is not executable as baox', async () => {
  const isolated = target({ denyBaoxPython: true });
  const preview = await isolated.host.execute({ kind: 'bootstrap-preview', source: { kind: 'proxy', proxy: 'http://proxy.example.test:7890' } });
  expect(preview.kind).toBe('bootstrap-preview');
  if (preview.kind !== 'bootstrap-preview') throw new Error('unexpected bootstrap preview response');

  await expect(isolated.host.execute({
    kind: 'bootstrap-apply',
    source: { kind: 'proxy', proxy: 'http://proxy.example.test:7890' },
    confirmationDigest: preview.value.plan.transactionDigest,
  })).rejects.toThrow('bootstrap');

  expect(isolated.appliedPackageTransaction).toBe(true);
}, REAL_SUBPROCESS_TIMEOUT_MS);

it('rechecks relay bytes on the target before the package transaction can apply', async () => {
  const isolated = target();
  for (const artifact of isolated.localArtifacts()) await isolated.host.uploadArtifact(artifact);
  writeFileSync(isolated.relayPath(isolated.artifacts.pnpm.sha256), 'tampered after upload');
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
}, REAL_SUBPROCESS_TIMEOUT_MS);
