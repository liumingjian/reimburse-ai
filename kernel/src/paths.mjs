import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// baox 的数据目录。Chrome 专用 profile、工作区状态、日志都在这里，
// 不碰用户自己的 Chrome 目录，也不碰材料源目录。
//
// 位置是用户自己找得到、打得开的 ~/.baox，不是一个按平台各不相同的系统目录：
// 出问题时第一句话永远是「打开 ~/.baox 看看」，而不是先解释 Application Support 在哪。
export function dataDir() {
  return process.env.BAOX_HOME || path.join(os.homedir(), '.baox');
}

/**
 * 0.9.x 的数据目录。只用来做一次性迁移，1.0.0 之后不再往里写。
 * 这三条分支就是老 dataDir() 的原样，改动它等于让老用户的数据认不出来。
 */
export function legacyDataDir() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'baox');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'baox');
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'baox');
}

export const paths = {
  get root() { return dataDir(); },
  get chromeProfile() { return path.join(dataDir(), 'chrome-profile'); },
  get run() { return path.join(dataDir(), 'run'); },
  get logs() { return path.join(dataDir(), 'logs'); },
};

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  return p;
}

/** 迁移完在新目录留下的字条。它在不在无关紧要，判据是新目录在不在。 */
export const MIGRATION_MARKER = 'migrated-from.txt';

/**
 * 把 0.9.x 的数据目录**拷**到新位置。已经迁过（新目录存在）或没什么可迁就返回 null。
 *
 * 拷不是搬：旧目录原样留着，用户装回 0.9.x 还能接着用。代价是磁盘上多一份
 * chrome-profile，比起把人锁在新版里，这份代价值得。
 *
 * 先拷进 <target>.migrating 再整体改名，所以中途断电不会留下一个「看起来搬完了」
 * 的半份目录 —— 判据是新目录在不在，半份目录会让迁移永远不再发生。
 */
export function migrateLegacyHome(target, legacy) {
  if (fs.existsSync(target)) return null;
  if (!fs.existsSync(legacy) || !fs.statSync(legacy).isDirectory()) return null;

  const staging = `${target}.migrating`;
  fs.rmSync(staging, { recursive: true, force: true });
  ensureDir(path.dirname(target));
  // runtime/ 是「已安装内核」这个已经不存在的概念留下的东西，搬过去只是一份没人跑的旧代码。
  fs.cpSync(legacy, staging, {
    recursive: true,
    filter: (src) => src !== path.join(legacy, 'runtime'),
  });
  fs.writeFileSync(path.join(staging, MIGRATION_MARKER),
    `${new Date().toISOString()}\n这个目录是从 ${legacy} 拷过来的（拷贝，不是移动）。\n`
    + '旧目录原样留在那里，装回 0.9.x 仍然能用；确认新版一切正常后可以自行删掉它。\n');
  fs.renameSync(staging, target);

  return { from: legacy, to: target };
}

/**
 * 启动时调一次。BAOX_HOME 显式指了目录就不迁 —— 那是用户点名的位置，
 * 往里塞一份别处的旧数据是自作主张。
 */
export function migrateOnStartup() {
  if (process.env.BAOX_HOME) return null;
  return migrateLegacyHome(dataDir(), legacyDataDir());
}
