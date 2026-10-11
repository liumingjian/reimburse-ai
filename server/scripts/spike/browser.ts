// One headless Chromium per spike session: a throwaway profile, a free CDP port, the executor's own launcher
// (`ensureChromium` with `headless`) and its own attach path (`cdpBrowser`), plus what only a spike needs — the process
// tree's memory, read from /proc, and a teardown that leaves no browser and no profile behind.
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdpBrowser, ensureChromium } from '@baox/erp-executor/browser';
import { connect, evalIn, type CdpSession } from '@baox/erp-executor/cdp';
import { sameOrigin } from '@baox/erp-executor/probe';
import { sleep, waitFor } from '@baox/erp-executor/pace';

export type MemorySample = { pids: number; rssMb: number; pssMb: number | null };
export type MemoryPeak = { samples: number; peakRssMb: number; peakPssMb: number | null; maxPids: number; minMemAvailableMb: number | null };

export type Headless = {
  label: string; port: number; pid: number | null; profileDir: string; launchMs: number;
  /** The ERP page, attached the way the executor attaches (focus emulation included). */
  session: CdpSession;
  /** A renderer crash or the browser process vanishing: the OOM signal S7 asks for. */
  crashes: string[];
  memory(): MemoryPeak | null;
  close(): Promise<string[]>;
};

const mb = (kb: number) => Math.round(kb / 1024);

/** Ask the kernel for a port nobody holds, then give it back for Chromium to take. */
async function freePort(): Promise<number> {
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

/** MemAvailable from /proc/meminfo, in MB; null off Linux. */
export function memAvailableMb(): number | null {
  try { return mb(kbOf(readFileSync('/proc/meminfo', 'utf8'), 'MemAvailable')); } catch { return null; }
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/**
 * Start one headless Chromium on a fresh profile, open `openUrl`, and attach to that page through the executor's
 * `cdpBrowser` — the same attach a real job uses. Throws if the browser cannot be started or the page never appears.
 */
export async function launchHeadless({ label, openUrl, origin, chromium }: { label: string; openUrl: string; origin: string; chromium: string | null }): Promise<Headless> {
  const profileDir = await mkdtemp(join(tmpdir(), `baox-spike-${label}-`));
  const port = await freePort();
  const env = chromium ? { ...process.env, BAOX_CHROME: chromium } : process.env;
  const started = Date.now();
  let pid: number | null = null;
  const crashes: string[] = [];
  const peak: MemoryPeak = { samples: 0, peakRssMb: 0, peakPssMb: null, maxPids: 0, minMemAvailableMb: null };
  let sampler: ReturnType<typeof setInterval> | null = null;
  let session: CdpSession | null = null;

  const close = async (): Promise<string[]> => {
    const notes: string[] = [];
    if (sampler) clearInterval(sampler);
    sampler = null;
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
    // A profile holds the ERP session cookie; it must not outlive the run.
    for (let i = 0; i < 5; i += 1) {
      try { await rm(profileDir, { recursive: true, force: true }); break; } catch { await sleep(500); }
    }
    notes.push(`${label}: 浏览器已关闭，临时配置目录已删除`);
    return notes;
  };

  try {
    pid = (await ensureChromium({ port, profileDir, openUrl, env, timeoutMs: 45_000, headless: true })).pid;
    if (pid !== null && process.platform === 'linux') {
      const take = () => {
        if (!alive(pid!)) { if (!crashes.includes('browser-exited')) crashes.push('browser-exited'); return; }
        const now = treeMemory(pid!);
        const free = memAvailableMb();
        peak.samples += 1;
        peak.peakRssMb = Math.max(peak.peakRssMb, now.rssMb);
        if (now.pssMb !== null) peak.peakPssMb = Math.max(peak.peakPssMb ?? 0, now.pssMb);
        peak.maxPids = Math.max(peak.maxPids, now.pids);
        if (free !== null) peak.minMemAvailableMb = Math.min(peak.minMemAvailableMb ?? free, free);
      };
      take();
      sampler = setInterval(take, 500);
      sampler.unref();
    }
    const browser = cdpBrowser(port);
    const page = (await waitFor(async () => (await browser.listPages().catch(() => [])).find((p) => sameOrigin(p.url, origin)) ?? null,
      Boolean, 45_000, 500));
    if (!page) throw new Error(`${label}: 45 秒内没有出现 ERP 页面（${origin}）`);
    session = (await browser.attach(page)).session;
    session.on?.('Inspector.targetCrashed', () => { crashes.push('renderer-crashed'); });
    await session.send('Inspector.enable').catch(() => null);
    const launchMs = Date.now() - started;
    const live = session;
    return { label, port, pid, profileDir, launchMs, session: live, crashes, memory: () => (pid !== null && process.platform === 'linux' ? { ...peak } : null), close };
  } catch (error) {
    await close();
    throw error;
  }
}

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
