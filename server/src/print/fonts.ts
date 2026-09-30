import { readdirSync } from 'node:fs';
import { join } from 'node:path';

// CJK fallback for everything drawn on @napi-rs/canvas: the print header and pdfjs page renders. pdfjs draws a
// non-embedded font (common on 电子发票 (e-invoices)) with a generic family (`sans-serif`, `serif`, `monospace`).
// On macOS those fall back to a CJK face per glyph. On the intranet Kylin host they do not, even with Noto Sans CJK
// installed, so every Chinese glyph rendered as a box (QA, 2026-09-30). When the generic family cannot draw CJK,
// a system CJK font file is registered under the generic names; `setAlias` does not take effect there.

export const FONT_DIRS: readonly string[] = ['/usr/share/fonts', '/usr/local/share/fonts'];
export const GENERIC_FAMILIES = ['sans-serif', 'serif', 'monospace'] as const;

// Regular weights first; a Bold-only install (the Kylin host ships NotoSansCJK-Bold.ttc alone) is still better than boxes.
const PREFERENCE: readonly RegExp[] = [
  /NotoSansCJK[^/]*-Regular\.tt[cf]$/i,
  /NotoSans(SC|CJKsc)-Regular\.[ot]tf$/i,
  /SourceHanSans[^/]*-Regular\.[ot]t[cf]$/i,
  /wqy-microhei\.ttc$/i,
  /wqy-zenhei\.ttc$/i,
  /DroidSansFallback(Full)?\.ttf$/i,
  /NotoSansCJK[^/]*\.tt[cf]$/i,
  /SourceHanSans[^/]*\.[ot]t[cf]$/i,
  /NotoSerifCJK[^/]*\.tt[cf]$/i,
];

// The preferred CJK font among `files` (absolute paths), or null when none is a known CJK font.
export function pickCjkFont(files: readonly string[]): string | null {
  const sorted = [...files].sort();
  for (const pattern of PREFERENCE) {
    const found = sorted.find((file) => pattern.test(file));
    if (found) return found;
  }
  return null;
}

// Font files under `dirs`, a few levels deep; unreadable or missing directories are skipped.
export function listFontFiles(dirs: readonly string[] = FONT_DIRS, depth = 4): string[] {
  const files: string[] = [];
  const walk = (dir: string, left: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && left > 0) walk(path, left - 1);
      else if (entry.isFile() && /\.(ttf|ttc|otf|otc)$/i.test(entry.name)) files.push(path);
    }
  };
  for (const dir of dirs) walk(dir, depth);
  return files;
}

export type CjkFallbackHost = {
  // True when `family` draws two different CJK characters differently (a missing glyph draws the same box).
  rendersCjk: (family: string) => boolean;
  register: (file: string, family: string) => void;
  fontFiles: () => readonly string[];
};

// Registers a CJK font under the generic families when `sans-serif` cannot draw CJK. Returns the registered file,
// or null when nothing was needed or nothing was found.
export function installCjkFallback(host: CjkFallbackHost): string | null {
  if (host.rendersCjk('sans-serif')) return null;
  const file = pickCjkFont(host.fontFiles());
  if (!file) return null;
  for (const family of GENERIC_FAMILIES) host.register(file, family);
  return file;
}

type CanvasModule = typeof import('@napi-rs/canvas');

function canvasHost(canvas: CanvasModule): CjkFallbackHost {
  const glyph = (family: string, text: string) => {
    const surface = canvas.createCanvas(32, 32);
    const context = surface.getContext('2d');
    context.font = `24px ${family}`;
    context.fillText(text, 2, 26);
    return Buffer.from(context.getImageData(0, 0, 32, 32).data).toString('base64');
  };
  return {
    rendersCjk: (family) => glyph(family, '本') !== glyph(family, '地'),
    register: (file, family) => {
      canvas.GlobalFonts.registerFromPath(file, family);
    },
    fontFiles: () => listFontFiles(),
  };
}

let installed: Promise<CanvasModule> | null = null;

// @napi-rs/canvas with the CJK fallback in place; the check runs once per process.
export function canvasWithCjk(): Promise<CanvasModule> {
  installed ??= import('@napi-rs/canvas').then((canvas) => {
    installCjkFallback(canvasHost(canvas));
    return canvas;
  });
  return installed;
}
