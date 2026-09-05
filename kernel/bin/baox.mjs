#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { paths, ensureDir } from '../src/paths.mjs';
import * as chrome from '../src/chrome.mjs';
import { probeIdentity, ERP_ORIGIN } from '../src/probe.mjs';
import { serveSelection } from '../src/serve.mjs';

// 退出码是给 Skill 用的确定性信号：
//   0 完成   1 内核出错   2 硬阻塞（内核拒绝继续，任何"确认继续"都不能绕过）
const OK = 0, ERR = 1, BLOCKED = 2;

const out = (obj, code = OK) => { process.stdout.write(JSON.stringify(obj, null, 2) + '\n'); process.exit(code); };

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}

const [, , cmd] = process.argv;

try {
  switch (cmd) {
    case 'doctor': {
      const [major] = process.versions.node.split('.').map(Number);
      const checks = {
        node: { value: process.versions.node, ok: major >= 21,
          hint: major >= 21 ? null : '内核用 Node 内建的全局 WebSocket 走 CDP，需要 Node 21 及以上' },
        chrome: { value: chrome.findChrome(), ok: !!chrome.findChrome(), hint: chrome.findChrome() ? null : '未找到 Chrome' },
        dataDir: { value: paths.root, ok: true },
        cdp: { value: chrome.CDP_PORT, ok: !!(await chrome.version()), hint: '专用 Chrome 未在运行；跑 baox chrome-up' },
      };
      ensureDir(paths.root);
      out({ command: 'doctor', platform: process.platform, checks,
        ready: checks.node.ok && checks.chrome.ok }, checks.node.ok && checks.chrome.ok ? OK : ERR);
    }

    case 'install-runtime': {
      // 内核零依赖，所以"安装"就是把这份源码整份拷进 baox 数据目录。
      // 三个 Skill 都调用数据目录里的这一份，避免各自夹带一份导致版本漂移。
      const self = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
      const dest = path.join(paths.root, 'runtime');
      const version = fs.readFileSync(path.join(self, 'VERSION'), 'utf8').trim();
      const installed = fs.existsSync(path.join(dest, 'VERSION'))
        ? fs.readFileSync(path.join(dest, 'VERSION'), 'utf8').trim() : null;
      ensureDir(paths.root);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(self, dest, { recursive: true });
      out({ command: 'install-runtime', from: self, to: dest, version, replaced: installed,
        entry: path.join(dest, 'bin', 'baox.mjs') });
    }

    case 'chrome-up': {
      const info = await chrome.launch({ openUrl: arg('url', `${ERP_ORIGIN}/k3cloud/html5/index.aspx`) });
      out({ command: 'chrome-up', ...info, profile: paths.chromeProfile,
        note: '这是 baox 专用的 Chrome 实例和独立 profile，和你日常那个 Chrome 互不影响；请在这个窗口里用你本人的账号登录 ERP' });
    }

    case 'probe': {
      const r = await probeIdentity({ expected: arg('expect') });
      out({ command: 'probe', ...r }, r.status === 'matched' ? OK : BLOCKED);
    }

    case 'select': {
      const specPath = arg('spec');
      if (!specPath) out({ command: 'select', error: '缺少 --spec <file.json>' }, ERR);
      const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
      const r = await serveSelection(spec, {
        timeoutMs: Number(arg('timeout-ms', 8 * 60 * 1000)),
        onReady: (url) => process.stderr.write(`打开这个地址做选择：${url}\n`),
      });
      out({ command: 'select', ...r }, r.status === 'submitted' ? OK : ERR);
    }

    default:
      out({ error: `未知命令 ${cmd ?? '(空)'}`, commands: ['doctor', 'chrome-up', 'probe', 'select'] }, ERR);
  }
} catch (err) {
  out({ command: cmd, error: err.message, code: err.code ?? null }, ERR);
}
