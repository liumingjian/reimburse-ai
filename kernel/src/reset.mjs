import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function validateResetHome(home) {
  const resolved = path.resolve(home);
  const invalid = () => ({ ok: false, status: 'invalid_home',
    speak: '这个 BAOX_HOME 不是可安全重置的本地目录；本地内容没有清除。' });
  if (!path.isAbsolute(home) || resolved === path.parse(resolved).root || resolved === os.homedir()) {
    return invalid();
  }
  if (!fs.existsSync(home)) return { ok: true, empty: true };
  const stat = fs.lstatSync(home);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return invalid();
  return { ok: true, empty: fs.readdirSync(home).length === 0 };
}

export async function resetHome(home, { closeBrowser }) {
  const valid = validateResetHome(home);
  if (!valid.ok) {
    return valid;
  }

  const closed = await closeBrowser();
  if (!closed.ok) {
    return {
      status: 'browser_close_failed',
      speak: 'baox 专用浏览器无法关闭。请手动关闭后再重试 Reset；本地内容没有清除。',
    };
  }
  const failed = [];
  for (const name of fs.readdirSync(home)) {
    try {
      fs.rmSync(path.join(home, name), { recursive: true, force: true });
    } catch {
      failed.push(name);
    }
  }
  const remaining = fs.readdirSync(home);
  if (failed.length || remaining.length) {
    return {
      status: 'reset_failed',
      remaining,
      speak: 'baox 的本地内容未能全部清除。请处理后重试 Reset。',
    };
  }
  return {
    status: 'reset',
    speak: 'baox 已完全重置。ERP 中已保存或提交的历史信息请自行删除；未保存的历史页面直接关闭即可。',
  };
}
