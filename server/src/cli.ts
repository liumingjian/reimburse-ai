import { existsSync } from 'node:fs';
import { resetPasswordLocally } from './accounts/accounts';
import { databasePath } from './data-dir';
import { openDatabase } from './db/database';

// The local `baox` command line (ADR-0018). Today only `baox admin reset-password <username>`: the way back in for a
// locked-out sole admin, where access to the machine counts as authority. It writes the data directory's database
// directly (no session, no running server needed; a running server sees the change on its next request).

export type CliIo = { dataDir: string; out: (line: string) => void; err: (line: string) => void };

const USAGE = '用法：baox admin reset-password <用户名>';

// Exit codes: 0 done, 1 refused (no database, unknown username), 2 usage error.
export async function runCli(argv: readonly string[], { dataDir, out, err }: CliIo): Promise<number> {
  const [group, command, username, ...rest] = argv;
  if (group !== 'admin' || command !== 'reset-password' || !username || rest.length > 0) {
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
    const temporary = await resetPasswordLocally(db, username);
    if (temporary === null) {
      err(`没有用户名为 ${username} 的账号。`);
      return 1;
    }
    out(`已重置账号 ${username} 的密码，它的所有登录已退出。`);
    out(`临时密码：${temporary}`);
    out('用临时密码登录后，必须先改成你自己的密码。');
    return 0;
  } finally {
    await db.destroy();
  }
}
