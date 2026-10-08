import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installCjkFallback, listFontFiles, pickCjkFont, type CjkFallbackHost } from './fonts';

// QA 2026-09-30: on the intranet Kylin host every Chinese glyph in the print header and in rendered e-invoices was a
// box, although Noto Sans CJK was installed; the generic families there have no CJK fallback.

const KYLIN_FONTS = [
  '/usr/share/fonts/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/google-droid-fonts/DroidSans.ttf',
  '/usr/share/fonts/google-noto-cjk/NotoSansCJK-Bold.ttc',
];

function fakeHost(rendersCjk: boolean, files: readonly string[]) {
  const registered: [string, string][] = [];
  const host: CjkFallbackHost = { rendersCjk: () => rendersCjk, register: (file, family) => registered.push([file, family]), fontFiles: () => files };
  return { host, registered };
}

describe('CJK fallback for the print canvas', () => {
  it('registers the host CJK font under every generic family when sans-serif draws CJK as boxes', () => {
    const { host, registered } = fakeHost(false, KYLIN_FONTS);
    expect(installCjkFallback(host)).toBe('/usr/share/fonts/google-noto-cjk/NotoSansCJK-Bold.ttc');
    expect(registered.map(([, family]) => family)).toEqual(['sans-serif', 'serif', 'monospace']);
  });

  it('leaves a host that already draws CJK (macOS) alone', () => {
    const { host, registered } = fakeHost(true, KYLIN_FONTS);
    expect(installCjkFallback(host)).toBeNull();
    expect(registered).toEqual([]);
  });

  it('prefers a regular weight over bold', () => {
    expect(pickCjkFont(['/f/NotoSansCJK-Bold.ttc', '/f/NotoSansCJK-Regular.ttc'])).toBe('/f/NotoSansCJK-Regular.ttc');
    expect(pickCjkFont(['/f/wqy/wqy-microhei.ttc', '/f/DroidSansFallbackFull.ttf'])).toBe('/f/wqy/wqy-microhei.ttc');
    expect(pickCjkFont(['/f/DejaVuSans.ttf'])).toBeNull();
  });

  it('finds font files in nested font directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'fonts-'));
    mkdirSync(join(root, 'google-noto-cjk'));
    writeFileSync(join(root, 'google-noto-cjk', 'NotoSansCJK-Bold.ttc'), '');
    writeFileSync(join(root, 'README'), '');
    expect(listFontFiles([root, join(root, 'missing')])).toEqual([join(root, 'google-noto-cjk', 'NotoSansCJK-Bold.ttc')]);
  });
});
