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
