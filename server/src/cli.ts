import { existsSync } from 'node:fs';
import { emergencyResetAdminPassword } from './accounts/accounts';
import { acquireDataDirLock, DataDirLockedError, databasePath } from './data-dir';
import { openDatabase } from './db/database';
import { readDurableMaintenanceState } from './maintenance';

// The local `baox` command line (ADR-0018 as amended by #228). One command only: `baox admin emergency-reset
// <username>`, which unlocks the sole active administrator and nothing else — see `emergencyResetAdminPassword` for
// why it is that narrow. It writes the data directory's database directly, so it acquires the same exclusive lock as
// the server and only proceeds while the durable maintenance barrier is explicitly open.

export type CliIo = { dataDir: string; out: (line: string) => void; err: (line: string) => void };

const USAGE = '用法：baox admin emergency-reset <管理员用户名>';
const SERVER_RUNNING = '应用正在运行，不能在服务运行时重置管理员密码。请先停止服务。';
const MAINTENANCE_BLOCKED = '维护状态未确认或正在维护，不能重置管理员密码。';

const REFUSALS: Record<'unknown_account' | 'not_admin' | 'not_sole_admin', (username: string) => string> = {
  unknown_account: (username) => `没有用户名为 ${username} 的账号。`,
  not_admin: (username) => `${username} 不是管理员账号。这个命令只能重置管理员账号；其他账号的密码请由管理员在网页里重置。`,
  not_sole_admin: (username) => `还有别的管理员账号可以用，所以这个命令不重置 ${username}：它只在只剩一个能用的管理员时才管用。请另一位管理员在网页的账号管理里给 ${username} 设置临时密码。`,
};

// Exit codes: 0 done, 1 refused (no database, unknown username, the target is not the only active administrator),
// 2 usage error.
export async function runCli(argv: readonly string[], { dataDir, out, err }: CliIo): Promise<number> {
  const [group, command, username, ...rest] = argv;
  if (group !== 'admin' || command !== 'emergency-reset' || !username || rest.length > 0) {
    err(USAGE);
    return 2;
  }
  const path = databasePath(dataDir);
  if (!existsSync(path)) {
    err(`数据目录 ${dataDir} 里还没有数据库，没有可以重置的账号。`);
    return 1;
  }
  let release: (() => void) | null = null;
  try {
    release = acquireDataDirLock(dataDir);
  } catch (error) {
    if (error instanceof DataDirLockedError) {
      err(SERVER_RUNNING);
      return 1;
    }
    throw error;
  }
  try {
    // This read-only check precedes `openDatabase`, whose migration and backup work would otherwise be a write under
    // an admitted or damaged barrier.
    if (readDurableMaintenanceState(path) !== 'open') {
      err(MAINTENANCE_BLOCKED);
      return 1;
    }
    const db = await openDatabase(path);
    try {
      const outcome = await emergencyResetAdminPassword(db, username);
      if ('refused' in outcome) {
        err(REFUSALS[outcome.refused](username));
        return 1;
      }
      out(`已重置管理员账号 ${username} 的密码，它的所有登录已退出，这次重置已记入审计。`);
      out(`临时密码：${outcome.temporaryPassword}`);
      out('用临时密码登录后，必须先改成你自己的密码。');
      return 0;
    } finally {
      await db.destroy();
    }
  } finally {
    release();
  }
}
