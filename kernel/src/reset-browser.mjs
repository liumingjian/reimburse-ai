import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { version, connect, CDP_PORT } from './chrome.mjs';

// Reset only closes the explicitly assigned baox space. It never creates a
// replacement space or clears cookies inherited from the user's browser.
export async function closeResetTaskSpace() {
  const configured = process.env.BAOX_EGO_TASK_SPACE?.trim();
  if (!configured) return { ok: true };
  const id = /^\d+$/.test(configured) ? Number(configured) : configured;
  const marker = '__BAOX_RESET__';
  const script = `
try {
  const id = ${JSON.stringify(id)};
  const spaces = await listTaskSpaces();
  const space = spaces.find((s) => typeof id === 'number'
    ? Number(s.id) === id : s.name === id || s.taskId === id);
  const result = space ? await completeTaskSpace(space.id, { keep: false }) : { done: true };
  const deadline = Date.now() + 5000;
  let gone = !space;
  while (result.done === true && !gone && Date.now() < deadline) {
    gone = !(await listTaskSpaces()).some((s) => String(s.id) === String(space.id));
    if (!gone) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  cliLog(${JSON.stringify(marker)} + JSON.stringify({ ok: result.done === true && gone }));
} catch {
  cliLog(${JSON.stringify(marker)} + JSON.stringify({ ok: false }));
}
`;
  return new Promise((resolve) => {
    const child = execFile(process.env.BAOX_EGO_BROWSER || 'ego-browser', ['nodejs'],
      { timeout: 15_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        const line = `${stdout}\n${stderr}`.split(/\r?\n/).reverse()
          .find((candidate) => candidate.includes(marker));
        try {
          resolve({ ok: !error && JSON.parse(line.slice(line.indexOf(marker) + marker.length)).ok === true });
        } catch {
          resolve({ ok: false });
        }
      });
    child.stdin.on('error', () => {});
    child.stdin.end(script);
  });
}

// Old installations may still have a dedicated Chrome running. Verify its
// process arguments before closing it; a stale PID must not affect another app.
async function closeLegacyChrome(home) {
  const pidFile = path.join(home, 'run', 'chrome.pid');
  if (!fs.existsSync(pidFile)) return { ok: true };
  const raw = fs.readFileSync(pidFile, 'utf8').trim();
  if (!/^[1-9]\d*$/.test(raw)) return { ok: true };
  const pid = Number(raw);
  try { process.kill(pid, 0); } catch (error) {
    return { ok: error.code === 'ESRCH' };
  }
  let command;
  try {
    command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim();
  } catch { return { ok: false }; }
  const profile = path.join(home, 'chrome-profile');
  const ownsProfile = command.includes(`--user-data-dir=${profile} `)
    || command.endsWith(`--user-data-dir=${profile}`);
  if (!ownsProfile) return { ok: true };
  const port = Number(command.match(/--remote-debugging-port=(\d+)(?:\s|$)/)?.[1] ?? CDP_PORT);
  const current = await version(port);
  if (!current?.webSocketDebuggerUrl) return { ok: false };
  const session = await connect(current.webSocketDebuggerUrl, { timeout: 3000 });
  try { await session.send('Browser.close'); } catch {
    // Browser.close may disconnect before replying; check the actual result.
  } finally { session.close(); }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!await version(port)) return { ok: true };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { ok: false };
}

export async function closeResetBrowsers(homes) {
  const ego = await closeResetTaskSpace();
  if (!ego.ok) return ego;
  for (const home of homes) {
    const result = await closeLegacyChrome(home);
    if (!result.ok) return result;
  }
  return { ok: true };
}
