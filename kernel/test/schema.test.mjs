import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { execFileSync } from 'node:child_process';
import { SCHEMA_VERSION } from '../src/state.mjs';
import { AGENT_MARKERS } from '../src/guard.mjs';
import { seedReadyRuntimes } from './runtime-fixture.mjs';

// 版本闸的判据从代码版本改成了数据格式版本，所以 schema.json 就是闸门本身。
// 这一层测的是它落盘的规矩：没有就补，有了就一个字都不动。

// CDP 端口指到 1：普通进程绑不上这个特权端口，所以它**永远**没人监听，
// 环境判定稳稳停在 env_chrome_down。原来用的 9457 只是"大概没人用"，
// 而真机上跑着 baox 自己那个 Chrome 时它就是被占的，整组用例跟着塌。
const CLOSED_PORT = '1';

const BIN = path.join(path.dirname(path.dirname(url.fileURLToPath(import.meta.url))), 'bin', 'baox.mjs');
const SCHEMA_FILE = 'schema.json';

function baox(args, home) {
  const env = { ...process.env, BAOX_HOME: home, ...seedReadyRuntimes(home), BAOX_CDP_PORT: CLOSED_PORT };
  for (const k of AGENT_MARKERS) delete env[k];
  try {
    return { code: 0, json: JSON.parse(execFileSync(process.execPath, [BIN, ...args],
      { encoding: 'utf8', env })) };
  } catch (err) {
    return { code: err.status, json: JSON.parse(err.stdout) };
  }
}

const materials = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-schema-src-'));
  fs.writeFileSync(path.join(dir, 'fp.pdf'), '%PDF-1.4\n');
  return dir;
};

test('格式版本定为 1', () => {
  assert.equal(SCHEMA_VERSION, 1);
});

test('新数据目录跑一条命令，schema.json 就落下来了', () => {
  const home = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'baox-schema-')), 'baox');
  baox(['next', '--dir', materials()], home);
  const written = JSON.parse(fs.readFileSync(path.join(home, SCHEMA_FILE), 'utf8'));
  assert.equal(written.schemaVersion, SCHEMA_VERSION);
});

test('已经有的 schema.json 一个字都不动 —— 改回去等于拆掉 schema_too_new', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-schema2-'));
  const file = path.join(home, SCHEMA_FILE);
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 99, mine: true }));

  const { code, json } = baox(['next', '--dir', materials()], home);

  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { schemaVersion: 99, mine: true });
  assert.equal(json.state, 'schema_too_new', '比内核新的目录必须硬停');
  assert.equal(code, 2);
});
