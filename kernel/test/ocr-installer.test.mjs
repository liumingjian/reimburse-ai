import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const INSTALLER = path.join(REPO, 'packages', 'image-field-extraction', 'scripts', 'install-runtime.mjs');
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'baox-ocr-installer-'));

test('OCR installer lets uv manage Python 3.11 instead of requiring a global interpreter', (t) => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    t.skip('the managed OCR v1 installer is Apple Silicon macOS only');
    return;
  }
  const home = tempDir();
  const fakeBin = path.join(home, 'fake-uv');
  const fakePython = path.join(home, 'fake-python');
  fs.writeFileSync(fakePython, '#!/bin/sh\nprintf \'{"type":"ready","engine":"rapidocr","version":"3.9.2","model":"PP-OCRv6-small"}\\n\'\n', { mode: 0o700 });
  fs.writeFileSync(fakeBin, [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then exit 0; fi',
    'if [ "$1" = "venv" ]; then',
    '  target="$4"',
    '  mkdir -p "$target/bin"',
    '  cp "$BAOX_FAKE_PYTHON" "$target/bin/python"',
    '  chmod +x "$target/bin/python"',
    'fi',
    'exit 0',
  ].join('\n'), { mode: 0o700 });

  const output = execFileSync(process.execPath, [INSTALLER, '--yes'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      BAOX_HOME: home,
      BAOX_UV: fakeBin,
      BAOX_FAKE_PYTHON: fakePython,
    },
  });
  assert.match(output, /managed Python 3\.11/);
  assert.ok(fs.existsSync(path.join(home, 'ocr-runtime', 'v1', 'bin', 'python')));
});
