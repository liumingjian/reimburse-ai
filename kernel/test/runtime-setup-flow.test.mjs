import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { determineState, SCHEMA_VERSION } from '../src/state.mjs';
import { stepFor } from '../src/next.mjs';
import {
  defaultOcrInstallerPath,
  defaultOcrRequirementsPath,
  runtimeDependencyStep,
} from '../src/runtime-dependencies.mjs';
import { runMarkItDown } from '../src/pdf-markdown.mjs';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'baox-runtime-setup-flow-'));

test('formal setup stops at runtime setup, then advances after managed runtimes are ready', () => {
  const home = tempDir();
  const install = runtimeDependencyStep({ home });
  const base = {
    schemaVersion: SCHEMA_VERSION,
    nodeVersion: '22.14.0',
    nodeMajor: 22,
    browserMode: 'system',
    cdpUp: true,
    probe: { status: 'no_tab', transport: 'system' },
    binding: null,
  };
  const missing = {
    ...base,
    runtimeDependencies: {
      status: 'blocked',
      ready: false,
      missing: ['markitdown', 'extract-reimbursement-images'],
      install,
    },
  };

  const blocked = determineState(missing);
  assert.equal(blocked.state, 'env_runtime_missing');
  const first = stepFor(blocked.state, missing, blocked.blockedBy);
  assert.equal(first.step.kind, 'run');
  assert.deepEqual(first.step.argv, install.argv);
  assert.equal(first.step.out, install.out);
  assert.deepEqual(first.step.env, install.env);

  const ready = {
    ...base,
    runtimeDependencies: { status: 'ready', ready: true, missing: [], install },
  };
  const advanced = determineState(ready);
  assert.equal(advanced.state, 'env_identity_unknown');
  const next = stepFor(advanced.state, ready, advanced.blockedBy);
  assert.equal(next.step.kind, 'run');
  assert.equal(next.step.argv[2], 'browser-open');
});

test('bundled OCR defaults resolve repository and installed sibling layouts', () => {
  assert.match(defaultOcrInstallerPath(), /packages[\\/]image-field-extraction[\\/]scripts[\\/]install-runtime\.mjs$/);
  assert.match(defaultOcrRequirementsPath(), /packages[\\/]image-field-extraction[\\/]python[\\/]requirements-rapid\.txt$/);
  assert.ok(fs.existsSync(defaultOcrInstallerPath()));
  assert.ok(fs.existsSync(defaultOcrRequirementsPath()));
});

test('PDF parsing invokes the injected managed Python directly without uv', async () => {
  const home = tempDir();
  const runnerPath = path.join(home, 'runner.mjs');
  const sourcePath = path.join(home, 'source.pdf');
  fs.writeFileSync(sourcePath, '%PDF-1.7\nfixture');
  fs.writeFileSync(runnerPath, [
    "process.stdout.write(JSON.stringify({status:'converted', markdown:'managed', title:'fixture'}));",
  ].join('\n'));

  const result = await runMarkItDown(sourcePath, {
    pythonPath: process.execPath,
    runnerPath,
    timeoutMs: 1000,
  });
  assert.deepEqual(result, { status: 'converted', markdown: 'managed', title: 'fixture', error: null });
});
