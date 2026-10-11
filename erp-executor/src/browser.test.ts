// The launch line is the only part of `ensureChromium` that can be checked without starting a browser.
import { describe, expect, it } from 'vitest';
import { chromiumArgs } from './browser';

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
