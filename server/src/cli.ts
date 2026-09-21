import { existsSync } from 'node:fs';
import { emergencyResetAdminPassword } from './accounts/accounts';
import { databasePath } from './data-dir';
import { openDatabase } from './db/database';

// The local `baox` command line (ADR-0018 as amended by #228). One command only: `baox admin emergency-reset
// <username>`, which unlocks a locked-out administrator and nothing else — see `emergencyResetAdminPassword` for why
// it is that narrow. It writes the data directory's database directly, so it needs no session and no running server;
// a running server sees the change on its next request.

export type CliIo = { dataDir: string; out: (line: string) => void; err: (line: string) => void };

const USAGE = '用法：baox admin emergency-reset <管理员用户名>';

// Exit codes: 0 done, 1 refused (no database, unknown username, the target is not an administrator), 2 usage error.
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
  const db = await openDatabase(path);
  try {
    const outcome = await emergencyResetAdminPassword(db, username);
    if ('refused' in outcome) {
      err(outcome.refused === 'unknown_account' ? `没有用户名为 ${username} 的账号。` : `${username} 不是管理员账号。这个命令只能重置管理员账号；其他账号的密码请由管理员在网页里重置。`);
      return 1;
    }
    out(`已重置管理员账号 ${username} 的密码，它的所有登录已退出，这次重置已记入审计。`);
    out(`临时密码：${outcome.temporaryPassword}`);
    out('用临时密码登录后，必须先改成你自己的密码。');
    return 0;
  } finally {
    await db.destroy();
  }
}
