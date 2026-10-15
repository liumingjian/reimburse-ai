import { createReadStream, readFileSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { EXTENSION_PAIRING_ERRORS, LOCAL_EXECUTOR_DOWNLOAD_ERRORS, LOCAL_EXECUTOR_DOWNLOAD_PATH, LOCAL_EXECUTOR_PROGRAM_PATH, LOCAL_EXECUTOR_RELEASE_PATH, LocalExecutorPlatformSchema, localExecutorDownloadFilename } from '@baox/contract';
import type { Context, Hono } from 'hono';
import type { AppEnv } from '../accounts/http';
import { bearer } from '../extension/http';
import type { PairingService } from '../extension/pairing';
import { activeOrigin, type PublicOrigin } from '../public-origin';
import { LocalExecutorUnavailable, packageLocalExecutor, releaseOf, type LocalExecutorDist } from './package';

// The 本地执行器's distribution over HTTP (ADR-0035), in the two halves pairing has (`extension/http.ts`).

const unavailable = (c: Context, error: unknown) => {
  if (!(error instanceof LocalExecutorUnavailable)) throw error;
  console.error(error.message);
  return c.json({ error: { code: 'local_executor_unavailable', message: LOCAL_EXECUTOR_DOWNLOAD_ERRORS.unavailable } }, 503);
};

// Behind the session gate: the settings page's download, one zip per platform, stamped with the address it was served
// from. `dist` null (tests, `pnpm dev`) answers 503.
export function mountLocalExecutorDownloadRoute(app: Hono<AppEnv>, dist: LocalExecutorDist | null, cacheDir: string, publicOrigin: PublicOrigin | null): void {
  app.get(LOCAL_EXECUTOR_DOWNLOAD_PATH, async (c) => {
    const platform = LocalExecutorPlatformSchema.safeParse(c.req.query('platform'));
    if (!platform.success) return c.json({ error: { code: 'platform_invalid', message: LOCAL_EXECUTOR_DOWNLOAD_ERRORS.platform } }, 400);
    let zip: string;
    try {
      zip = await packageLocalExecutor(dist, platform.data, activeOrigin(publicOrigin, c.req.url), cacheDir);
    } catch (error) {
      return unavailable(c, error);
    }
    return c.body(Readable.toWeb(createReadStream(zip)) as ReadableStream, 200, {
      'Content-Type': 'application/zip',
      'Content-Length': String(statSync(zip).size),
      'Content-Disposition': `attachment; filename="${localExecutorDownloadFilename(platform.data)}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
  });
}

// Before the session gate: the executor has no session, only its pairing token. It asks what the server ships, and
// fetches the program when that is not what it runs (`local-executor/src/update.ts`).
export function mountLocalExecutorReleaseRoutes(app: Hono<AppEnv>, dist: LocalExecutorDist | null, pairings: PairingService): void {
  const paired = async (c: Context) => (await pairings.lookup(bearer(c))) !== null;
  const notPaired = (c: Context) => c.json({ error: { code: 'not_paired', message: EXTENSION_PAIRING_ERRORS.notPaired } }, 401);
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
