import { createReadStream, readFileSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import {
  PAIRING_ERRORS, LOCAL_EXECUTOR_INSTALL_MESSAGES, LOCAL_EXECUTOR_INSTALL_PATH, LOCAL_EXECUTOR_PROGRAM_PATH, LOCAL_EXECUTOR_RELEASE_ERRORS,
  LOCAL_EXECUTOR_RELEASE_PATH, LOCAL_EXECUTOR_RUNTIME_ERRORS, LOCAL_EXECUTOR_RUNTIME_PATH, LocalExecutorPlatformSchema, localExecutorUninstallPath,
} from '@baox/contract';
import type { Context, Hono } from 'hono';
import type { AppEnv } from '../accounts/http';
import { bearer } from '../extension/http';
import type { PairingService } from '../extension/pairing';
import { activeOrigin, type PublicOrigin } from '../public-origin';
import { expiredScript, macInstallScript, macUninstallScript, systemOfAgent, unavailableScript, windowsInstallScript, windowsUninstallScript } from './install-script';
import { LocalExecutorUnavailable, releaseOf, runtimeOf, type LocalExecutorDist } from './release';

// The 本地执行器's distribution over HTTP (ADR-0035): the install and uninstall scripts and what they download, and the
// executor's own update checks. There is no install package: the 设置页 shows the one command instead.

const unavailable = (c: Context, error: unknown) => {
  if (!(error instanceof LocalExecutorUnavailable)) throw error;
  console.error(error.message);
  return c.json({ error: { code: 'local_executor_unavailable', message: LOCAL_EXECUTOR_RELEASE_ERRORS.unavailable } }, 503);
};

// Before the session gate: the executor has no session, only its pairing token. It asks what the server ships, and
// fetches the program when that is not what it runs (`local-executor/src/update.ts`).
export function mountLocalExecutorReleaseRoutes(app: Hono<AppEnv>, dist: LocalExecutorDist | null, pairings: PairingService): void {
  const paired = async (c: Context) => (await pairings.lookup(bearer(c))) !== null;
  const notPaired = (c: Context) => c.json({ error: { code: 'not_paired', message: PAIRING_ERRORS.notPaired } }, 401);
  app.get(LOCAL_EXECUTOR_RELEASE_PATH, async (c) => {
    if (!(await paired(c))) return notPaired(c);
    try {
      return c.json(releaseOf(dist), 200, { 'Cache-Control': 'no-store' });
    } catch (error) {
      return unavailable(c, error);
    }
  });
  app.get(LOCAL_EXECUTOR_PROGRAM_PATH, async (c) => {
    if (!(await paired(c))) return notPaired(c);
    try {
      releaseOf(dist);
    } catch (error) {
      return unavailable(c, error);
    }
    return c.body(readFileSync(dist!.program), 200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  });
}

// Before the session gate and without a pairing: the install script runs before the PC is paired, on a PC without a
// usable Node, so it downloads Node's own runtime from here and checks it against the sha256 served beside it. HTTPS
// keeps the network out (ADR-0036); the sha256 catches a cut-off or corrupt download.
export function mountLocalExecutorRuntimeRoutes(app: Hono<AppEnv>, dist: LocalExecutorDist | null): void {
  const serve = (c: Context, answer: (runtime: { file: string; sha256: string }) => Response) => {
    const platform = LocalExecutorPlatformSchema.safeParse(c.req.param('platform'));
    if (!platform.success) return c.json({ error: { code: 'platform_invalid', message: LOCAL_EXECUTOR_RUNTIME_ERRORS.platform } }, 404);
    let runtime: { file: string; sha256: string };
    try {
      runtime = runtimeOf(dist, platform.data);
    } catch (error) {
      if (!(error instanceof LocalExecutorUnavailable)) throw error;
      console.error(error.message);
      return c.json({ error: { code: 'local_executor_unavailable', message: LOCAL_EXECUTOR_RUNTIME_ERRORS.unavailable } }, 503);
    }
    return answer(runtime);
  };
  app.get(`${LOCAL_EXECUTOR_RUNTIME_PATH}/:platform`, (c) => serve(c, ({ file }) => c.body(Readable.toWeb(createReadStream(file)) as ReadableStream, 200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(statSync(file).size),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })));
  app.get(`${LOCAL_EXECUTOR_RUNTIME_PATH}/:platform/sha256`, (c) => serve(c, ({ sha256 }) => c.text(`${sha256}\n`, 200, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })));
}

// Before the session gate and open to anyone who has the 配对码 (spec #412 part C): the one-command install. The code
// is the whole authority, as for redeeming it, and reading the script or the program never spends it. Every script
// answer is a 200, so `curl -f` / `irm` never print an English error: a code that cannot install gets a script that
// prints the Chinese sentence and exits non-zero. An unknown code has no system; `irm` names PowerShell in its
// User-Agent. The program answers 404 for such a code, which the script reads as the same sentence.
export function mountLocalExecutorInstallRoutes(app: Hono<AppEnv>, dist: LocalExecutorDist | null, pairings: PairingService, publicOrigin: PublicOrigin | null): void {
  const script = (c: Context, body: string) => c.text(body, 200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  // As redeeming reads it: stray spaces and dashes dropped, upper case.
  const canonical = (code: string) => code.replace(/[^0-9a-zA-Z]/g, '').toUpperCase();
  app.get(`${LOCAL_EXECUTOR_INSTALL_PATH}/:code`, async (c) => {
    const code = canonical(c.req.param('code'));
    const found = code ? await pairings.installCode(code) : null;
    if (!found) return script(c, expiredScript(systemOfAgent(c.req.header('user-agent'))));
    let runtime: string;
    try {
      runtime = releaseOf(dist).runtime;
    } catch (error) {
      if (!(error instanceof LocalExecutorUnavailable)) throw error;
      console.error(error.message);
      return script(c, unavailableScript(found.system));
    }
    // The major version of the runtime it serves, which is what an executor compares its own Node with (`update.ts`).
    const major = Number(runtime.split('.')[0]);
    const install = found.system === 'windows' ? windowsInstallScript : macInstallScript;
    return script(c, install({ origin: activeOrigin(publicOrigin, c.req.url), code, accountId: found.accountId, major }));
  });
  app.get(`${LOCAL_EXECUTOR_INSTALL_PATH}/:code/program`, async (c) => {
    if (!(await pairings.installCode(canonical(c.req.param('code'))))) return c.json({ error: { code: 'pairing_code_invalid', message: LOCAL_EXECUTOR_INSTALL_MESSAGES.expired } }, 404);
    try {
      releaseOf(dist);
    } catch (error) {
      return unavailable(c, error);
    }
    return c.body(readFileSync(dist!.program), 200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  });
  app.get(localExecutorUninstallPath('mac'), (c) => script(c, macUninstallScript()));
  app.get(localExecutorUninstallPath('windows'), (c) => script(c, windowsUninstallScript()));
}
