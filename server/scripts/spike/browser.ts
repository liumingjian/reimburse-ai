// One Chromium per spike session: a free CDP port, the executor's own command line (`chromiumArgs`, headless unless S8
// asks for a window) and its own attach path (`cdpBrowser`), plus what only a spike needs — the process tree's memory,
// read from /proc on Linux and from `ps` on macOS, and a teardown that leaves no browser behind. The profile is a
// throwaway one, deleted on close, unless the caller names a persistent one (S8: the profile an employee's PC keeps).
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdpBrowser, chromiumArgs, findChrome } from '@baox/erp-executor/browser';
import { connect, evalIn, type CdpSession } from '@baox/erp-executor/cdp';
import { sameOrigin } from '@baox/erp-executor/probe';
import { sleep, waitFor } from '@baox/erp-executor/pace';
import { tracePage, type PageTrace } from './trace';

export type MemorySample = { pids: number; rssMb: number; pssMb: number | null };
export type MemoryPeak = { samples: number; peakRssMb: number; peakPssMb: number | null; maxPids: number; minMemAvailableMb: number | null };

export type Headless = {
  label: string; port: number; pid: number | null; profileDir: string; launchMs: number; headless: boolean;
  /** The ERP page, attached the way the executor attaches (focus emulation included). */
  session: CdpSession;
  /** The ERP page's network and console since attach (trace.ts). */
  trace: PageTrace;
  /** A renderer crash or the browser process vanishing: the OOM signal S7 asks for. */
  crashes: string[];
  memory(): MemoryPeak | null;
  close(): Promise<string[]>;
};

const mb = (kb: number) => Math.round(kb / 1024);

/** Ask the kernel for a port nobody holds, then give it back for Chromium to take. */
export async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

/** Every process under `root`: its descendants by parent pid, plus anything still in its process group. Linux only. */
export function treePids(root: number): number[] {
  const parent = new Map<number, number>();
  const group = new Map<number, number>();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      // `pid (comm) state ppid pgrp …` — comm may hold spaces and parentheses, so fields are counted after the last ')'.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      parent.set(Number(name), Number(fields[1]));
      group.set(Number(name), Number(fields[2]));
    } catch { /* gone between readdir and read */ }
  }
  const tree = new Set<number>([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, ppid] of parent) if (!tree.has(pid) && tree.has(ppid)) { tree.add(pid); grew = true; }
  }
  for (const [pid, pgrp] of group) if (pgrp === root) tree.add(pid);
  return [...tree].filter((pid) => parent.has(pid));
}

const kbOf = (text: string, key: string) => Number(new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm').exec(text)?.[1] ?? NaN);

/**
 * Resident memory of the whole browser tree. RSS summed over processes counts shared pages once per process, so it
 * over-states; PSS splits them fairly and is the better estimate of what the host actually pays. Both are reported.
 */
export function treeMemory(root: number): MemorySample {
  let rss = 0;
  let pss = 0;
  let pssKnown = true;
  const pids = treePids(root);
  for (const pid of pids) {
    try { rss += kbOf(readFileSync(`/proc/${pid}/status`, 'utf8'), 'VmRSS') || 0; } catch { /* exited */ }
    try { pss += kbOf(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'), 'Pss') || 0; } catch { pssKnown = false; }
  }
  return { pids: pids.length, rssMb: mb(rss), pssMb: pssKnown ? mb(pss) : null };
}

/** The same over `ps` on macOS: RSS of every process in the tree, no PSS. */
function psTreeMemory(root: number): MemorySample | null {
  let out: string;
  try { out = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,rss='], { encoding: 'utf8' }); } catch { return null; }
  const rows = out.trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number));
  const tree = new Set<number>([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, ppid, pgid] of rows) if (!tree.has(pid!) && (tree.has(ppid!) || pgid === root)) { tree.add(pid!); grew = true; }
  }
  const mine = rows.filter(([pid]) => tree.has(pid!));
  return { pids: mine.length, rssMb: mb(mine.reduce((sum, row) => sum + (row[3] ?? 0), 0)), pssMb: null };
}

const sampleTree = (root: number): MemorySample | null =>
  (process.platform === 'linux' ? treeMemory(root) : process.platform === 'darwin' ? psTreeMemory(root) : null);

/** MemAvailable from /proc/meminfo, in MB; null off Linux. */
export function memAvailableMb(): number | null {
  try { return mb(kbOf(readFileSync('/proc/meminfo', 'utf8'), 'MemAvailable')); } catch { return null; }
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

export type LaunchOptions = {
  label: string; openUrl: string; origin: string; chromium: string | null;
  /** Default true. S8 also runs the same browser with a window. */
  headless?: boolean;
  /** A profile that outlives the run (S8); null: a throwaway one, deleted on close. */
  profileDir?: string | null;
  /** Put before the URL, after `chromiumArgs`' own: S8's `--load-extension`. */
  extraArgs?: string[];
};

/** Start Chromium the way `ensureChromium` does (same binary lookup, same `chromiumArgs`), plus `extraArgs`. */
async function startChromium({ port, profileDir, openUrl, chromium, headless, extraArgs }: { port: number; profileDir: string; openUrl: string; chromium: string | null; headless: boolean; extraArgs: string[] }): Promise<number | null> {
  const bin = findChrome(chromium ? { ...process.env, BAOX_CHROME: chromium } : process.env);
  if (!bin) throw new Error('没有找到 Chrome 或 Chromium；用 --chromium 或 BAOX_CHROME 指定');
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  const args = chromiumArgs({ port, profileDir, openUrl, headless });
  args.splice(args.length - 1, 0, ...extraArgs);
  const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
  let failure: string | null = null;
  child.once('error', (error) => { failure = error.message; });
  child.once('exit', (code, signal) => { failure ??= `Chromium 在自动化端口就绪前退出（code=${code}, signal=${signal}）`; });
  child.unref();
  const up = async () => (failure ? null : fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false));
  const ready = await waitFor(up, (state) => state !== false, 45_000, 300);
  if (failure) throw new Error(failure);
  if (ready !== true) throw new Error(`Chromium 已启动，但自动化端口 ${port} 在 45 秒内没有响应`);
  return child.pid ?? null;
}

/**
 * Start one Chromium (headless unless asked otherwise), open `openUrl`, and attach to that page through the executor's
 * `cdpBrowser` — the same attach a real job uses. Throws if the browser cannot be started or the page never appears.
 */
export async function launchBrowser({ label, openUrl, origin, chromium, headless = true, profileDir: keep = null, extraArgs = [] }: LaunchOptions): Promise<Headless> {
  const profileDir = keep ?? await mkdtemp(join(tmpdir(), `baox-spike-${label}-`));
  const port = await freePort();
  const started = Date.now();
  let pid: number | null = null;
  const crashes: string[] = [];
  const peak: MemoryPeak = { samples: 0, peakRssMb: 0, peakPssMb: null, maxPids: 0, minMemAvailableMb: null };
  let sampler: ReturnType<typeof setInterval> | null = null;
  let session: CdpSession | null = null;
  let trace: PageTrace | null = null;

  const close = async (): Promise<string[]> => {
    const notes: string[] = [];
    if (sampler) clearInterval(sampler);
    sampler = null;
    trace?.stop();
    try { session?.close(); } catch { /* already closed */ }
    // Browser.close over the browser's own endpoint is the orderly way; the process group is the backstop.
    try {
      const version = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) })).json() as { webSocketDebuggerUrl?: string };
      if (version.webSocketDebuggerUrl) {
        const browser = await connect(version.webSocketDebuggerUrl, { timeout: 5000 });
        await browser.send('Browser.close', {}, { timeout: 5000 }).catch(() => null);
        browser.close();
      }
    } catch { /* not answering any more */ }
    if (pid !== null) {
      await waitFor(async () => alive(pid!), (up) => !up, 8000, 250);
      if (alive(pid)) {
        try { process.kill(-pid, 'SIGKILL'); notes.push(`${label}: Browser.close 之后进程还在，已按进程组强制结束`); } catch { /* raced */ }
        if (process.platform === 'linux') for (const child of treePids(pid)) { try { process.kill(child, 'SIGKILL'); } catch { /* raced */ } }
      }
    }
    // A throwaway profile holds the ERP session cookie; it must not outlive the run. A persistent one is kept on purpose.
    for (let i = 0; i < 5 && !keep; i += 1) {
      try { await rm(profileDir, { recursive: true, force: true }); break; } catch { await sleep(500); }
    }
    notes.push(`${label}: 浏览器已关闭，${keep ? '持久配置目录保留' : '临时配置目录已删除'}`);
    return notes;
  };

  try {
    pid = await startChromium({ port, profileDir, openUrl, chromium, headless, extraArgs });
    if (pid !== null && (process.platform === 'linux' || process.platform === 'darwin')) {
      const take = () => {
        if (!alive(pid!)) { if (!crashes.includes('browser-exited')) crashes.push('browser-exited'); return; }
        const now = sampleTree(pid!);
        if (!now) return;
        const free = memAvailableMb();
        peak.samples += 1;
        peak.peakRssMb = Math.max(peak.peakRssMb, now.rssMb);
        if (now.pssMb !== null) peak.peakPssMb = Math.max(peak.peakPssMb ?? 0, now.pssMb);
        peak.maxPids = Math.max(peak.maxPids, now.pids);
        if (free !== null) peak.minMemAvailableMb = Math.min(peak.minMemAvailableMb ?? free, free);
      };
      take();
      sampler = setInterval(take, process.platform === 'linux' ? 500 : 1000);
      sampler.unref();
    }
    const browser = cdpBrowser(port);
    const page = (await waitFor(async () => (await browser.listPages().catch(() => [])).find((p) => sameOrigin(p.url, origin)) ?? null,
      Boolean, 45_000, 500));
    if (!page) throw new Error(`${label}: 45 秒内没有出现 ERP 页面（${origin}）`);
    session = (await browser.attach(page)).session;
    session.on?.('Inspector.targetCrashed', () => { crashes.push('renderer-crashed'); });
    await session.send('Inspector.enable').catch(() => null);
    trace = await tracePage(session);
    const launchMs = Date.now() - started;
    const live = session;
    return { label, port, pid, profileDir, launchMs, headless, session: live, trace, crashes, memory: () => (pid !== null && peak.samples > 0 ? { ...peak } : null), close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** The spike's original launcher: headless, on a throwaway profile. Without field trials, as S8 and the local executor
 * launch: Chrome for Testing's trials block the ERP (`ERR_BLOCKED_BY_CLIENT`), so its page never loads. */
export const launchHeadless = (options: Omit<LaunchOptions, 'headless' | 'profileDir' | 'extraArgs'>) =>
  launchBrowser({ ...options, extraArgs: ['--disable-field-trial-config'] });

/** Open `url` in a second tab of the same browser, wait for it to load, and close it again. For S1's piaozone check. */
export async function loadInTab(port: number, url: string, { timeoutMs = 45_000, shot }: { timeoutMs?: number; shot?: (session: CdpSession) => Promise<unknown> } = {}) {
  const started = Date.now();
  // Chrome answers GET /json/new with 405 since v111; PUT is the documented verb.
  const created = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURI(url)}`, { method: 'PUT', signal: AbortSignal.timeout(10_000) })).json() as { id?: string; webSocketDebuggerUrl?: string };
  if (!created.webSocketDebuggerUrl) throw new Error('新标签页没有 CDP 地址');
  const tab = await connect(created.webSocketDebuggerUrl);
  try {
    const state = await waitFor(
      () => evalIn<{ ready: string; title: number; text: number; origin: string }>(tab, `({ ready: document.readyState, title: document.title.length, text: (document.body?.innerText || '').trim().length, origin: location.origin })`).catch(() => null),
      (s) => s?.ready === 'complete' && s.text > 0, timeoutMs, 500);
    if (shot) await shot(tab);
    return { loaded: state?.ready === 'complete' && (state?.text ?? 0) > 0, ready: state?.ready ?? null, titleLength: state?.title ?? 0, textLength: state?.text ?? 0, finalOrigin: state?.origin ?? null, ms: Date.now() - started };
  } finally {
    tab.close();
    if (created.id) await fetch(`http://127.0.0.1:${port}/json/close/${created.id}`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
  }
}
