import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { remoteShellCommand, SshHostTransport } from './host.js';
import { NATIVE_PROFILE } from './profile.js';

it('keeps apostrophes and newlines intact when SSH passes a fixed remote script through sh -c', () => {
  const script = "printf '%s\\n' \"first apostrophe: it's here\"\nprintf '%s\\n' second-line";

  const output = execFileSync('sh', ['-c', remoteShellCommand(script)], { encoding: 'utf8' });

  expect(output).toBe("first apostrophe: it's here\nsecond-line\n");
});

it('treats a malformed gate response as incompatible before a routine deployment can proceed', async () => {
  const target = new SshHostTransport({
    runner: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ version: 1, state: 'open', barrier: false, activeWrites: -1, activeErpAttempt: false }),
    }),
  });

  await expect(target.execute({ kind: 'gate-status' })).resolves.toEqual({ kind: 'gate-status', value: { kind: 'incompatible-gate' } });
});

it('passes an isolated profile only to an injected test runner', async () => {
  const profile = { ...NATIVE_PROFILE, host: 'isolated.test', deployRoot: '/tmp/baox', dataDir: '/tmp/baox/data', maintenanceWrapper: '/tmp/baox/bin/gate', maintenanceSocket: '/tmp/baox/data/gate.sock' };
  let seenProfile: typeof profile | null = null;
  const target = new SshHostTransport({
    profile,
    runner: async (actualProfile) => {
      seenProfile = actualProfile;
      return { exitCode: 69, stdout: '' };
    },
  });

  await expect(target.execute({ kind: 'gate-status' })).resolves.toEqual({ kind: 'gate-status', value: { kind: 'unavailable-gate' } });

  expect(seenProfile).toEqual(profile);
});
