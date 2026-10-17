// What the installed 本地执行器 does first at every start (ADR-0035, #424): recheck the Node its config records,
// switch to the downloaded runtime when that Node no longer qualifies, record the choice, and make the start-at-login
// entry match it. A zip install, which recorded no Node and whose entry ran `runtime/node` directly with whatever
// environment the PC had, takes the recorded-path, cleared-environment form here on its first start under this
// program. When the Node chosen is not the one running, the caller restarts into it (RESTART_EXIT_CODE).

import { readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { LocalExecutorConfigSchema, type LocalExecutorConfig } from '@baox/contract';
import { autostartFiles, downloadedRuntimePath, syncInstallFiles, type InstallFile } from './install';
import { chooseNode, nodeProbe, type NodeProbe } from './runtime';

export const readConfig = (configFile: string): LocalExecutorConfig => LocalExecutorConfigSchema.parse(JSON.parse(readFileSync(configFile, 'utf8')) as unknown);

export function writeConfig(configFile: string, config: LocalExecutorConfig): void {
  const next = `${configFile}.next`;
  writeFileSync(next, JSON.stringify(config));
  renameSync(next, configFile);
}

/** Record `node` in the config, and write the start entry that runs it. Whether the entry changed. */
export function recordNode({ configFile, node, sync = syncInstallFiles, ...where }: {
  configFile: string; node: string; platform: string; appDir: string; logsDir: string; userHome: string; appData?: string;
  sync?: (files: readonly InstallFile[]) => boolean;
}): boolean {
  const config = readConfig(configFile);
  if (config.node !== node) writeConfig(configFile, { ...config, node });
  return sync(autostartFiles({ ...where, node, origin: config.origin, runtimePlatform: config.platform }));
}

const samePath = (a: string, b: string) => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
};

export type StartPorts = {
  platform: NodeJS.Platform;
  userHome: string;
  appData?: string;
  appDir: string;
  logsDir: string;
  configFile: string;
  /** The Node running this process. */
  execPath: string;
  /** The server's Node major version. */
  major: number;
  probe?: NodeProbe;
  fetch?: typeof fetch;
  sync?: (files: readonly InstallFile[]) => boolean;
};

export async function prepareStart({ platform, userHome, appData, appDir, logsDir, configFile, execPath, major, probe = nodeProbe(), fetch: get = fetch, sync = syncInstallFiles }: StartPorts): Promise<{ node: string; restart: boolean; rewrote: boolean; why?: string }> {
  const config = readConfig(configFile);
  const choice = await chooseNode({
    recorded: config.node, downloaded: downloadedRuntimePath(appDir, platform), platform, major, probe, userHome,
    runtime: { origin: config.origin, platform: config.platform, fetch: get },
  });
  const rewrote = recordNode({ configFile, node: choice.path, platform, appDir, logsDir, userHome, ...(appData ? { appData } : {}), sync });
  return { node: choice.path, restart: !samePath(choice.path, execPath), rewrote, ...(choice.why ? { why: choice.why } : {}) };
}
