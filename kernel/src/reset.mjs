import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { legacyDataDir } from './paths.mjs';
import { closeResetBrowsers } from './reset-browser.mjs';

// These directories contain installed code/models, not reimbursement state.
const RUNTIMES = new Set(['runtime', 'runtimes', 'ocr-runtime']);

export function validateResetHome(home) {
  const resolved = path.resolve(home);
  const invalid = () => ({ ok: false, status: 'invalid_home',
    speak: '这个 BAOX_HOME 不是可安全重置的本地目录；本地内容没有清除。' });
  if (!path.isAbsolute(home) || resolved === path.parse(resolved).root || resolved === os.homedir()) {
    return invalid();
  }
  try {
    const stat = fs.lstatSync(home);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return invalid();
    const real = fs.realpathSync(home);
    if (real === path.parse(real).root || real === fs.realpathSync(os.homedir())) return invalid();
    return { ok: true };
  } catch (error) {
    return error.code === 'ENOENT' ? { ok: true } : invalid();
  }
}

export async function resetHome(home, {
  legacy = process.env.BAOX_HOME ? null : legacyDataDir(),
  closeBrowser = closeResetBrowsers,
} = {}) {
  // An explicit BAOX_HOME is an isolated installation, as it is for migration.
  const homes = [...new Set([home, legacy].filter(Boolean).map((p) => path.resolve(p)))];
  const targets = homes.flatMap((root) => [root, `${root}.migrating`]);
  for (const target of [home, ...targets]) {
    const valid = validateResetHome(target);
    if (!valid.ok) return valid;
  }
  try {
    const closed = await closeBrowser(homes);
    if (!closed.ok) throw new Error('browser_close_failed');
  } catch {
    return { status: 'browser_close_failed',
      speak: 'baox 专属浏览器空间未能关闭，本地内容尚未清除；关闭失败的空间后重试 reset。' };
  }
  const remaining = [];
  for (const target of targets) {
    try {
      if (!fs.existsSync(target)) continue;
      for (const name of fs.readdirSync(target)) {
        if (homes.includes(target) && RUNTIMES.has(name)) continue;
        fs.rmSync(path.join(target, name), { recursive: true, force: true });
      }
      remaining.push(...fs.readdirSync(target)
        .filter((name) => !homes.includes(target) || !RUNTIMES.has(name))
        .map((name) => path.join(target, name)));
      if (!homes.includes(target)) fs.rmdirSync(target);
    } catch {
      remaining.push(target);
    }
  }
  // Keep an empty root so startup cannot restore a legacy copy after reset.
  try { fs.mkdirSync(home, { recursive: true, mode: 0o700 }); } catch { remaining.push(home); }
  if (remaining.length) return { status: 'reset_failed', remaining,
    speak: 'baox 的本地内容未能全部清除，请处理剩余路径后重试 reset。' };
  return { status: 'reset', speak: 'baox 已完全重置。' };
}
