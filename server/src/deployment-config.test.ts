import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

it.each([undefined, 'http://10.250.0.222:9999', 'https://baox.example.com:9443', 'https://baox.example.com'])('renders one active public origin with override %s and an independent internal port', (override) => {
  const output = mkdtempSync(join(tmpdir(), 'baox-deployment-'));
  directories.push(output);
  const env = { ...process.env };
  delete env['BAOX_PUBLIC_ORIGIN'];
  if (override) env['BAOX_PUBLIC_ORIGIN'] = override;
  execFileSync(process.execPath, [resolve('../deploy/intranet/render-config.mjs'), output], { env });
  const origin = override ?? 'http://10.250.0.222:8888';
  expect(readFileSync(join(output, 'baox.service'), 'utf8')).toContain(`Environment=BAOX_PUBLIC_ORIGIN=${origin}\n`);
  expect(readFileSync(join(output, 'baox.service'), 'utf8')).toContain('Environment=BAOX_PORT=4319\n');
  expect(readFileSync(join(output, 'Caddyfile'), 'utf8')).toContain(`${origin} {`);
  const url = new URL(origin);
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  expect(readFileSync(join(output, 'origin.txt'), 'utf8')).toBe(`${origin}\n${origin}\n${url.hostname}:${port}:127.0.0.1:${port}\n`);
});

it('refuses an invalid origin before writing a configuration', () => {
  const output = mkdtempSync(join(tmpdir(), 'baox-deployment-'));
  directories.push(output);
  expect(() => execFileSync(process.execPath, [resolve('../deploy/intranet/render-config.mjs'), output], { env: { ...process.env, BAOX_PUBLIC_ORIGIN: 'https://example.com/path' }, stdio: 'pipe' })).toThrow();
  expect(() => readFileSync(join(output, 'baox.service'))).toThrow();
});
