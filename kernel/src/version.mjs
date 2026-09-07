/**
 * 版本号的读取与比较。bin/launch.mjs 和 bin/baox.mjs 都要用，所以放在这里 ——
 * 两边各写一份的话，闸门两侧对「哪个版本更新」的看法迟早会分岔。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 读一份内核目录的 VERSION；读不到（没装、没这个文件、空文件）一律 null。 */
export const versionAt = (root) => {
  try { return fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim() || null; } catch { return null; }
};

// 只取开头的数字段：0.9.1 -> [0,9,1]，9.9.10-test -> [9,9,10]。
// 后缀（-test、-rc1）不参与比较，所以 1.0.0-rc1 和 1.0.0 算同一版。
// 这里不需要完整的 semver：版本号是我们自己发的，够用就行，不够用时宁可返回"比不了"。
const parts = (v) => {
  const m = /^(\d+(?:\.\d+)*)/.exec(v ?? '');
  return m ? m[1].split('.').map(Number) : null;
};

/**
 * a 比 b 新返回正数，旧返回负数，同版返回 0。
 * **任一边解析不出数字就返回 null（比不了）** —— 调用方必须把 null 当作
 * "无法证明是降级"，而不是当作降级。拿不准就阻塞的话，一个手写坏了的 VERSION
 * 就能把用户锁死在数据目录里。
 */
export function compareVersions(a, b) {
  const x = parts(a), y = parts(b);
  if (!x || !y) return null;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}
