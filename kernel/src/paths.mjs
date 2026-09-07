import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// baox 的数据目录。内核、Chrome 专用 profile、工作区状态都在这里，
// 不碰用户自己的 Chrome 目录，也不碰材料源目录。
export function dataDir() {
  if (process.env.BAOX_HOME) return process.env.BAOX_HOME;
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

/**
 * 数据根下那几份个人文件（identity.json、projects.json）的落盘规格，写在一处。
 *
 * 原子写：先写临时文件再 rename，所以读者在任何一刻看到的要么是上一版、
 * 要么是这一版，没有半份文件这种中间态。目录 0700、文件 0600 ——
 * 里面是"这台机器替谁报销"和"他有哪些项目"，不该给同机的别人看。
 *
 * 两边各抄一份的话，两份个人文件对"什么叫写安全了"的看法迟早会分岔，
 * 而分岔的那一半不会报错，它只是安静地少一道保护。
 */
export function writeJsonAtomic(file, record) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  return record;
}
