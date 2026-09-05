#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { paths, ensureDir } from '../src/paths.mjs';
import * as chrome from '../src/chrome.mjs';
import { probeIdentity, ERP_ORIGIN } from '../src/probe.mjs';
import { serveSelection } from '../src/serve.mjs';
import { takeInventory, intakeOpenItems } from '../src/inventory.mjs';
import { classifyInventory, classifyOpenItems, summarize } from '../src/classify.mjs';
import { findLiveTaskForSource, createTask, recordInventory, recordClassification,
  sourceKeyOf, taskDir } from '../src/workspace.mjs';

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

    case 'intake': {
      const dir = arg('dir');
      if (!dir) out({ command: 'intake', error: '缺少 --dir <材料目录>' }, ERR);

      const inventory = await takeInventory(dir);
      const key = sourceKeyOf(dir);
      // 同一个目录再次运行时，恢复原任务而不是新建第二个（契约「重复运行与历史材料」）。
      const existing = findLiveTaskForSource(key);
      const task = existing ?? createTask(dir);
      const rec = recordInventory(task, inventory);

      const items = intakeOpenItems(inventory);
      const blocking = items.filter((i) => i.blocking);
      const byDisposition = {};
      for (const m of inventory.materials) byDisposition[m.disposition] = (byDisposition[m.disposition] ?? 0) + 1;

      out({
        command: 'intake',
        task: { taskId: rec.task.taskId, createdAt: rec.task.createdAt, status: rec.task.status,
          sourceLabel: rec.task.sourceLabel, resumed: !!existing, workspace: taskDir(rec.task) },
        inventory: { versionId: inventory.versionId, takenAt: inventory.takenAt,
          isNewVersion: rec.isNewVersion, supersededVersionId: rec.supersededVersionId,
          versionCount: rec.versionCount,
          materialCount: inventory.materials.length, ignoredCount: inventory.ignored.length,
          byDisposition },
        materials: inventory.materials.map(({ materialId, relPath, format, size, disposition, reason, contentHash }) =>
          ({ materialId, relPath, format, size, disposition, reason, contentHash: contentHash?.slice(0, 16) ?? null })),
        ignored: inventory.ignored,
        openItems: items,
        // 待确认项一条未清就不能进入下一步；这是契约的放行条件，不是建议。
        readyForNextStep: blocking.length === 0,
      }, blocking.length === 0 ? OK : BLOCKED);
    }

    case 'classify': {
      const dir = arg('dir');
      if (!dir) out({ command: 'classify', error: '缺少 --dir <材料目录>' }, ERR);

      // 分流永远建立在一个确定的盘点版本之上，所以这里先重新盘一次（幂等）。
      // 盘点层还有硬阻塞时不往下解析：范围外和读不出来的材料先解决，再谈票种。
      const inventory = await takeInventory(dir);
      const existing = findLiveTaskForSource(sourceKeyOf(dir));
      const task = existing ?? createTask(dir);
      const rec = recordInventory(task, inventory);

      const intakeItems = intakeOpenItems(inventory);
      const intakeBlocking = intakeItems.filter((i) => i.blocking);
      if (intakeBlocking.length) {
        out({ command: 'classify', stage: 'intake',
          task: { taskId: rec.task.taskId, resumed: !!existing, workspace: taskDir(rec.task) },
          inventory: { versionId: inventory.versionId, materialCount: inventory.materials.length },
          openItems: intakeItems,
          readyForNextStep: false,
          note: '材料盘点还有未清的待确认项，先处理它们再做分流与解析' }, BLOCKED);
      }

      const classification = classifyInventory(dir, inventory);
      const file = recordClassification(rec.task, classification);
      const items = classifyOpenItems(classification);
      const blocking = items.filter((i) => i.blocking);
      const byRole = {};
      for (const r of classification.results) {
        if (r.parseStatus === 'skipped') continue;
        byRole[r.role ?? 'unknown'] = (byRole[r.role ?? 'unknown'] ?? 0) + 1;
      }

      out({
        command: 'classify', stage: 'classify',
        task: { taskId: rec.task.taskId, resumed: !!existing, workspace: taskDir(rec.task) },
        inventory: { versionId: inventory.versionId, isNewVersion: rec.isNewVersion,
          supersededVersionId: rec.supersededVersionId, materialCount: inventory.materials.length },
        byRole,
        // 完整发票号码只留在任务工作区文件里，输出一律脱敏 ——
        // 重复分组的 identityKey 里也带着完整号码，这里一并去掉。
        materials: summarize(classification),
        duplicates: classification.duplicates.map(({ identityKey, ...d }) => d),
        openItems: items,
        factsFile: file,
        readyForNextStep: blocking.length === 0,
      }, blocking.length === 0 ? OK : BLOCKED);
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
      out({ error: `未知命令 ${cmd ?? '(空)'}`, commands: ['doctor', 'install-runtime', 'chrome-up', 'probe', 'intake', 'classify', 'select'] }, ERR);
  }
} catch (err) {
  out({ command: cmd, error: err.message, code: err.code ?? null }, ERR);
}
