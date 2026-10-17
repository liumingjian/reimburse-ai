// The launch line is the only part of `ensureChromium` that can be checked without starting a browser.
import { describe, expect, it } from 'vitest';
import { chromiumArgs, findChrome } from './browser';

const base = { port: 9333, profileDir: '/tmp/profile', openUrl: 'http://erp.example/k3cloud/html5/index.aspx' };

describe('chromiumArgs', () => {
  it('starts headed by default, with the URL last', () => {
    const args = chromiumArgs(base);
    expect(args).toEqual([
      '--remote-debugging-port=9333', '--user-data-dir=/tmp/profile', '--no-first-run', '--no-default-browser-check',
      '--disable-features=Translate', 'http://erp.example/k3cloud/html5/index.aspx',
    ]);
    expect(args.some((arg) => arg.startsWith('--headless'))).toBe(false);
  });

  it('adds the new headless mode and a desktop-sized window only when asked', () => {
    const args = chromiumArgs({ ...base, headless: true });
    expect(args).toContain('--headless=new');
    expect(args).toContain('--window-size=1920,1080');
    expect(args.at(-1)).toBe(base.openUrl);
  });
});

describe('findChrome on Windows', () => {
  const only = (path: string) => (candidate: string) => candidate === path;

  it('takes a system-wide Chrome first', () => {
    expect(findChrome({ LOCALAPPDATA: 'C:\\Users\\zhang\\AppData\\Local' }, 'win32', () => true)).toBe('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  });

  it('finds a Chrome installed for this user only', () => {
    const perUser = 'C:\\Users\\zhang\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
    expect(findChrome({ LOCALAPPDATA: 'C:\\Users\\zhang\\AppData\\Local' }, 'win32', only(perUser))).toBe(perUser);
  });

  it('falls back to Edge, which every Windows has', () => {
    const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    expect(findChrome({}, 'win32', only(edge))).toBe(edge);
  });

  it('finds nothing rather than guessing', () => {
    expect(findChrome({}, 'win32', () => false)).toBeNull();
  });
});
