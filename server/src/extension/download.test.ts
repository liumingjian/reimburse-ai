import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, inflateRawSync } from 'node:zlib';
import { compareExtensionVersions, EXTENSION_DOWNLOAD_ERRORS, EXTENSION_DOWNLOAD_FILENAME, EXTENSION_DOWNLOAD_PATH, EXTENSION_MINIMUM_VERSION, EXTENSION_ORIGIN_PLACEHOLDER, EXTENSION_VERSION } from '@baox/contract';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestServer, TEST_PASSWORD, type TestServer } from '../test/harness';

// The HTTP seam (spec #246 Testing Decisions): the 浏览器扩展 (browser extension) zip the settings page downloads
// (#258), opened the way an employee's unzip tool opens it, and its manifest read the way the browser reads it.
//
// The template is the real one: `extension/scripts/build.mjs` runs once for the whole file, into a temporary
// directory, exactly as `pnpm build` runs it into `extension/dist`.

const BUILD_SCRIPT = fileURLToPath(new URL('../../../extension/scripts/build.mjs', import.meta.url));
const INTRANET = 'http://10.250.0.222:8888';
const json = { 'content-type': 'application/json' };

type Manifest = { version: string; host_permissions: string[]; content_scripts: { matches: string[]; js: string[] }[] };

let workDir: string;
let template: string;
let server: TestServer | null = null;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'baox-extension-'));
  template = join(workDir, 'template');
  execFileSync(process.execPath, [BUILD_SCRIPT, template], { stdio: 'pipe' });
});
afterAll(() => rmSync(workDir, { recursive: true, force: true }));
afterEach(async () => {
  await server?.close();
  server = null;
});

// Reads a zip through its central directory, as unzip tools do, and checks every entry's checksum on the way.
function unzip(bytes: Buffer): Map<string, string> {
  const files = new Map<string, string>();
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(end).toBeGreaterThanOrEqual(0);
  let at = bytes.readUInt32LE(end + 16);
  for (let index = 0; index < bytes.readUInt16LE(end + 10); index += 1) {
    expect(bytes.readUInt32LE(at)).toBe(0x02014b50);
    const nameLength = bytes.readUInt16LE(at + 28);
    const offset = bytes.readUInt32LE(at + 42);
    const start = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28);
    const data = inflateRawSync(bytes.subarray(start, start + bytes.readUInt32LE(at + 20)));
    expect(crc32(data)).toBe(bytes.readUInt32LE(at + 16));
    files.set(bytes.toString('utf8', at + 46, at + 46 + nameLength), data.toString('utf8'));
    at += 46 + nameLength + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
  }
  return files;
}

const download = async (response: Response) => {
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('application/zip');
  expect(response.headers.get('content-disposition')).toContain(EXTENSION_DOWNLOAD_FILENAME);
  const files = unzip(Buffer.from(await response.arrayBuffer()));
  return { files, manifest: JSON.parse(files.get('manifest.json') ?? 'null') as Manifest };
};

// A colleague's browser on the intranet signs in as the first admin and downloads the extension.
async function intranetDownload(extensionTemplate: string | null): Promise<Response> {
  const at = await createTestServer({ publicOrigin: INTRANET, extensionTemplate });
  server = at;
  const setup = await at.app.request(`${INTRANET}/api/auth/setup`, { method: 'POST', headers: { ...json, origin: INTRANET }, body: JSON.stringify({ username: 'alice', password: TEST_PASSWORD }) });
  expect(setup.status).toBe(200);
  const cookie = (setup.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  return at.app.request(`${INTRANET}${EXTENSION_DOWNLOAD_PATH}`, { headers: { cookie } });
}

describe('the extension download on the settings page', () => {
  it('serves a zip carrying exactly the origin the server admits, in host_permissions and in the code', async () => {
    const { files, manifest } = await download(await intranetDownload(template));

    // The files sit at the top of the zip, so the folder it unpacks to is the one to load.
    expect([...files.keys()]).toEqual(expect.arrayContaining(['manifest.json', 'service-worker.js', 'popup.js', 'popup.html']));
    // The guard compares origins as literal strings: `http://10.250.0.222:80` would be a different address to it.
    expect(manifest.host_permissions).toEqual([`${INTRANET}/*`]);
    // The page bridge (#290) runs on the app's own pages and nowhere else.
    expect(manifest.content_scripts.map((script) => script.matches)).toEqual([[`${INTRANET}/*`]]);
    expect(files.has(manifest.content_scripts[0]?.js[0] ?? '')).toBe(true);
    expect(files.get('service-worker.js')).toContain(JSON.stringify(INTRANET));
    expect(files.get('content-script.js')).toContain(JSON.stringify(INTRANET));
    for (const [name, text] of files) {
      expect(text, name).not.toContain(EXTENSION_ORIGIN_PLACEHOLDER);
      expect(text, name).not.toContain('10.250.0.222:80');
    }
  });

  it('serves the version this server ships, which is never one it would refuse', async () => {
    const { manifest } = await download(await intranetDownload(template));
    expect(manifest.version).toBe(EXTENSION_VERSION);
    expect(compareExtensionVersions(manifest.version, EXTENSION_MINIMUM_VERSION)).toBeGreaterThanOrEqual(0);
  });

  it('on a loopback-only install bakes in the loopback address the browser used', async () => {
    const at = await createTestServer({ extensionTemplate: template });
    server = at;
    const alice = await at.signIn('alice');
    const { manifest } = await download(await alice.request(`http://127.0.0.1:4319${EXTENSION_DOWNLOAD_PATH}`));
    expect(manifest.host_permissions).toEqual(['http://127.0.0.1:4319/*']);
  });

  it('is only for signed-in accounts', async () => {
    const at = await createTestServer({ extensionTemplate: template });
    server = at;
    expect((await at.app.request(EXTENSION_DOWNLOAD_PATH)).status).toBe(401);
  });

  it('refuses to serve a template left over from another build rather than hand out an extension of another version', async () => {
    const stale = join(workDir, 'stale');
    cpSync(template, stale, { recursive: true });
    const manifestPath = join(stale, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify({ ...(JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest), version: '0.9.0' }));

    const refused = await intranetDownload(stale);
    expect(refused.status).toBe(503);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toBe(EXTENSION_DOWNLOAD_ERRORS.unavailable);
  });

  it('refuses a template whose content script would run on pages other than the app', async () => {
    const wide = join(workDir, 'wide');
    cpSync(template, wide, { recursive: true });
    const manifestPath = join(wide, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, content_scripts: manifest.content_scripts.map((script) => ({ ...script, matches: ['<all_urls>'] })) }));

    expect((await intranetDownload(wide)).status).toBe(503);
  });

  it('says the package is not available when the extension was never built', async () => {
    expect((await intranetDownload(join(workDir, 'never-built'))).status).toBe(503);
  });
});
