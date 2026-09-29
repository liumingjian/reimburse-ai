// `pnpm --filter @baox/erp-executor probe <flow> --record <name>`: drive the live ERP through a named flow
// (flows.ts) and store its pages, redacted, as fake-ERP fixtures in src/testing/recordings/<name>/.
//
// Development only, and live: it runs on the maintainer's Mac over its VPN, in the dedicated Chromium profile
// (BAOX_ERP_LIVE_PROFILE, default ~/.baox-erp-live/chromium-profile), unattended:
//   . ~/.baox-erp-live/env; pnpm --filter @baox/erp-executor probe new-form --record new-form
// The env file exports BAOX_ERP_TEST_ACCOUNT, BAOX_ERP_TEST_TENANT and BAOX_ERP_TEST_PASSWORD, the dedicated test
// identity the live harness (server/scripts/test-erp-live.ts) uses. The recorder refuses any other logged-in
// identity. It signs in by itself when the session has lapsed — harness behaviour, never product behaviour
// (ADR-0016: the employee logs in) — and the password goes nowhere but the login form: every output is checked for
// the identity and the password before anything is written, and nothing is written when one is found.
//
// What it touches in ERP: a throwaway browser context (no cookies) shows the login page and is disposed; the flow
// runs in the profile's own ERP tab, and every unsaved 新增 tab there is closed before and after it, answering 否
// to 是否保存 (tabs.ts `closeNewFormTabs`, the product's own 重新去报销 path).
// The recording session refuses keys, uploads and any press on a save / submit / import control (recorder.ts).
// A page with a child frame (the 发票无忧助手) is written as NN-<step>.html plus NN-<step>.child.html.
//
// Optional: BAOX_ERP_ORIGIN, BAOX_CHROMIUM_CDP_PORT (9333), --out <dir> (default src/testing/recordings/<name>).

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureChromium } from '../browser';
import { connect, enableFocusEmulation, evalIn, targets, type CdpSession } from '../cdp';
import { cdpPortOf } from '../chromium';
import { DEFAULT_PACE, sleep } from '../pace';
import { DEFAULT_ERP_ORIGIN, erpEntryOf, READ_ONLY_SNIPPET, sameOrigin, type Observation } from '../probe';
import { closeFormTab, closeNewFormTabs, tabActions } from '../tabs';
import { CAPTURE_SNIPPET, type CapturedPage } from './capture';
import { FLOWS } from './flows';
import { findLeaks, redactor, type Secrets } from './redact';
import { recordingSession, type RecordedStep } from './recorder';
import { signInSnippet } from './sign-in';

const say = (line: string) => console.log(`[probe] ${line}`);
function refuse(message: string): never {
  console.error(`[probe] refused: ${message}`);
  process.exit(2);
}

const args = process.argv.slice(2);
const flowName = args[0];
const recordAt = args.indexOf('--record');
const name = recordAt >= 0 ? args[recordAt + 1] : undefined;
const outAt = args.indexOf('--out');
const flow = flowName ? FLOWS[flowName] : undefined;
if (!flowName || !flow) refuse(`usage: probe <flow> --record <name>; flows: ${Object.keys(FLOWS).join(', ')}`);
if (!name || !/^[a-z0-9-]+$/.test(name)) refuse('--record <name> is required: lower-case letters, digits and dashes.');
const outDir = outAt >= 0 && args[outAt + 1] ? args[outAt + 1]! : fileURLToPath(new URL(`../testing/recordings/${name}/`, import.meta.url));

const env = process.env;
const account = env['BAOX_ERP_TEST_ACCOUNT']?.trim() ?? '';
const tenant = env['BAOX_ERP_TEST_TENANT']?.trim() ?? '';
const password = env['BAOX_ERP_TEST_PASSWORD']?.trim() ?? '';
if (!account || !tenant) refuse('set BAOX_ERP_TEST_ACCOUNT and BAOX_ERP_TEST_TENANT (source ~/.baox-erp-live/env first).');
const origin = env['BAOX_ERP_ORIGIN']?.trim() || DEFAULT_ERP_ORIGIN;
const entry = erpEntryOf(origin);
const port = cdpPortOf(env);

await ensureChromium({ port, profileDir: env['BAOX_ERP_LIVE_PROFILE'] || join(homedir(), '.baox-erp-live', 'chromium-profile'), openUrl: entry, env });
const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as { webSocketDebuggerUrl: string };
const browser = await connect(version.webSocketDebuggerUrl, { timeout: 20_000 });
const opened: string[] = [];
let context: string | null = null;

/** A new tab on the ERP entry, in `browserContextId` when given, attached with focus emulation. */
async function openTab(browserContextId?: string): Promise<{ targetId: string; session: CdpSession }> {
  const { targetId } = await browser.send('Target.createTarget', { url: entry, ...(browserContextId ? { browserContextId } : {}) }) as { targetId: string };
  opened.push(targetId);
  for (let i = 0; i < 40; i += 1) {
    const target = (await targets(port)).find((t) => t.id === targetId && t.webSocketDebuggerUrl);
    if (target) {
      return { targetId, ...(await attachTab(target.webSocketDebuggerUrl!)) };
    }
    await sleep(250);
  }
  throw new Error('the new tab never showed up among the CDP targets');
}

async function attachTab(webSocketDebuggerUrl: string): Promise<{ session: CdpSession }> {
  const session = await connect(webSocketDebuggerUrl, { timeout: 20_000 });
  const focus = await enableFocusEmulation(session);
  if (!focus.ok) throw new Error(`focus emulation refused: ${focus.error}`);
  return { session };
}

/** Poll the read-only identity snippet until `done` says so. */
async function observe(session: CdpSession, done: (o: Observation) => boolean, ms: number): Promise<Observation | null> {
  const deadline = Date.now() + ms;
  let last: Observation | null = null;
  while (Date.now() < deadline) {
    last = await evalIn<Observation>(session, READ_ONLY_SNIPPET).catch(() => null);
    if (last && last.ready === 'complete' && done(last)) return last;
    await sleep(1000);
  }
  return last;
}

const identified = (o: Observation) => !!(o.displayName && o.account && o.tenant);
let exitCode = 1;
try {
  // 1. The login page, logged out: a browser context of its own has no session cookie and no stored login.
  ({ browserContextId: context } = await browser.send('Target.createBrowserContext', {}) as { browserContextId: string });
  const loggedOut = await openTab(context!);
  if (!(await observe(loggedOut.session, (o) => !!o.loginFormVisible, 60_000))?.loginFormVisible) throw new Error('the logged-out tab never showed the login form');
  await sleep(DEFAULT_PACE.settleMs);
  const loginPage = JSON.parse(await evalIn<string>(loggedOut.session, CAPTURE_SNIPPET, { timeout: 60_000 })) as CapturedPage;
  loggedOut.session.close();
  say(`login page: ${loginPage.count} elements (${loginPage.pruned} hidden, dropped)`);

  // 2. The flow, in the profile's own ERP tab. K3Cloud keeps its session per tab (a second tab on the entry page is
  // logged out), so this is the tab the live harness logs into and the executor drives. Unsaved 新增 tabs are
  // closed first, answering 否 to 是否保存, so the flow starts from the console and opens a form of its own.
  const erpTabs = (await targets(port)).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl && sameOrigin(t.url, origin) && !opened.includes(t.id ?? ''));
  if (erpTabs.length > 1) throw new Error(`${erpTabs.length} ERP tabs are open in the dedicated Chromium; close all but one`);
  const tab = erpTabs[0] ? await attachTab(erpTabs[0].webSocketDebuggerUrl!) : await openTab();
  let seen = await observe(tab.session, (o) => identified(o) || !!o.loginFormVisible, 90_000);
  if (seen && !identified(seen) && seen.loginFormVisible) {
    if (!password) throw new Error('the ERP session has lapsed and BAOX_ERP_TEST_PASSWORD is not set');
    say('the ERP session has lapsed; signing in as the dedicated test identity.');
    let submitted = false;
    for (let i = 0; i < 60 && !submitted; i += 1) {
      submitted = !!(await evalIn<{ ok: boolean }>(tab.session, signInSnippet(account, password)).catch(() => null))?.ok;
      if (!submitted) await sleep(1000);
    }
    seen = await observe(tab.session, identified, 90_000);
  }
  if (!seen || !identified(seen)) throw new Error('no logged-in ERP console in the recording tab');
  if (seen.account !== account || seen.tenant !== tenant) throw new Error('the logged-in ERP identity is not the dedicated test identity; nothing was recorded');
  const discard = async () => {
    const actions = tabActions(tab.session);
    const { closed, stuck } = await closeNewFormTabs(actions);
    for (const extra of (await actions.tabs()).filter((t) => flow.closeTabs.some((caption) => caption.test(t.text)))) {
      const outcome = await closeFormTab(actions, extra.id);
      if (outcome.closed) closed.push(extra.text);
      else stuck.push(`${extra.text}（${outcome.note}）`);
    }
    if (closed.length) say(`closed ${closed.length} tab(s) (${closed.join(', ')}); any 是否保存 was answered 否.`);
    if (stuck.length) throw new Error(`a tab would not close: ${stuck.join('; ')}`);
  };
  await discard();
  await sleep(DEFAULT_PACE.settleMs);

  const session = recordingSession(tab.session, { allowKeys: flow.allowKeys });
  const result = await flow.run({ session, pace: DEFAULT_PACE });
  session.stop();
  const steps: RecordedStep[] = session.steps;
  await discard();
  tab.session.close();

  // 3. Redact, check, write. Nothing reaches the disk before every output has passed the leak check.
  const secrets: Secrets = { displayName: seen.displayName!, account, tenant, password };
  const build = (/\d+(?:\.\d+)+/.exec(String(steps.at(-1)?.page.resVer ?? '')) ?? [null])[0];
  const redact = redactor({ secrets, keep: build ? [build] : [], mask: flow.mask });
  const command = `pnpm --filter @baox/erp-executor probe ${flowName} --record ${name}`;
  const header = (step: string) => `Recorded from the live ERP by the probe command (recording/cli.ts): flow ${flowName}, recording ${name}, step ${step}. Redacted:
values masked, digits zeroed, identity as {{DISPLAY_NAME}} {{ACCOUNT}} {{TENANT}}. Do not edit by hand: re-record.
data-rec-box is the live element box (x,y,width,height); data-rec-click marks where the next click landed.`;
  const files: Array<[string, string]> = [];
  const page = (step: RecordedStep | { name: string; page: CapturedPage }, file: string) => {
    const { html, facts } = redact.page(step.page, header(step.name));
    files.push([file, html]);
    let child = {};
    if ('child' in step && step.child) {
      const childFile = file.replace(/\.html$/, '.child.html');
      const frame = redact.page(step.child, header(`${step.name}, its child frame`));
      files.push([childFile, frame.html]);
      child = { child: { file: childFile, ...frame.facts } };
    }
    const click = 'click' in step && step.click ? { click: {
      ...redact.click(step.click.frame === 'child' && step.child ? step.child : step.page, step.click),
      ...(step.click.frame ? { frame: step.click.frame } : {}),
    } } : {};
    return { name: step.name, file, ...facts, ...child, ...click };
  };
  const manifest = {
    flow: flowName, name, description: flow.description, command, recordedAt: new Date().toISOString().slice(0, 10),
    erpBuild: build, result: JSON.parse(redact.text(JSON.stringify(result))),
    loggedOut: page({ name: 'login', page: loginPage }, 'login.html'),
    pages: steps.map((step, i) => page(step, `${String(i + 1).padStart(2, '0')}-${step.name}.html`)),
  };
  files.push(['manifest.json', `${JSON.stringify(manifest, null, 2)}\n`]);
  const leaks = [...new Set(files.flatMap(([, text]) => findLeaks(text, secrets)))];
  if (leaks.length) throw new Error(`redaction left ${leaks.join(', ')} in the output; nothing was written`);

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const [file, text] of files) writeFileSync(join(outDir, file), text);
  for (const [file, text] of files) say(`wrote ${file} (${Math.round(Buffer.byteLength(text) / 1024)} KB)`);
  say(`recorded ${flowName} as ${name}: ${steps.length} page(s) plus the login page; nothing was saved, submitted or imported.`);
  exitCode = 0;
} catch (error) {
  console.error(`[probe] ${error instanceof Error ? error.message : String(error)}`);
} finally {
  for (const targetId of opened) await browser.send('Target.closeTarget', { targetId }).catch(() => undefined);
  if (context) await browser.send('Target.disposeBrowserContext', { browserContextId: context }).catch(() => undefined);
  browser.close();
}
process.exit(exitCode);
