// The executor-import lint rule (ADR-0016): @baox/erp-executor is a standalone package, so nothing under its `src`
// may reach for the server — not through `@baox/server`, not through a relative path that climbs out of the package.
// Each case writes a throwaway file, runs the real oxlint config on it, and removes it again.
import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const oxlint = join(root, 'node_modules', '.bin', 'oxlint');

function lint(relativeDir: string, source: string) {
  const file = join(relativeDir, `__lint_probe_${process.pid}_${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(join(root, file), `${source}\nexport {};\n`);
  try {
    const run = spawnSync(oxlint, ['-c', '.oxlintrc.json', '--deny-warnings', file], { cwd: root, encoding: 'utf8' });
    return { failed: run.status !== 0, output: `${run.stdout}${run.stderr}` };
  } finally {
    rmSync(join(root, file), { force: true });
  }
}

const EXECUTOR = 'erp-executor/src';
const TESTING = 'erp-executor/src/testing';

describe('executor import boundary', () => {
  it.each([
    [EXECUTOR, "import { createErpJobs } from '@baox/server/erp/jobs';"],
    [EXECUTOR, "import { openDatabase } from '../../server/src/db/database';"],
    [EXECUTOR, "import { createApp } from '../../server/src/app';"],
    [TESTING, "import { createApp } from '../../../server/src/app';"],
    [TESTING, "import { judgeReadings } from '@baox/server/erp/readback';"],
  ])('fails when %s adds `%s`', (dir, source) => {
    const result = lint(dir, source);
    expect(result.failed, result.output).toBe(true);
    expect(result.output).toMatch(/no-restricted-imports/);
  });

  it.each([
    [EXECUTOR, "import { FillPlanSchema } from './protocol';"],
    [EXECUTOR, "import { evalIn } from './cdp';"],
    [EXECUTOR, "import { z } from 'zod';"],
    [TESTING, "import { FillPlanSchema } from '../protocol';"],
    [TESTING, "import { evalIn } from '../cdp';"],
    ['server/src/erp', "import { runFillJob } from '@baox/erp-executor/job';"],
  ])('passes when %s imports `%s`', (dir, source) => {
    const result = lint(dir, source);
    expect(result.failed, result.output).toBe(false);
  });
});
