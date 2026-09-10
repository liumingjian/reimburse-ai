import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-home-city-'));
process.env.BAOX_HOME = home;

const { readHomeCity, writeHomeCity, homeCityFile, validHomeCity } = await import('../src/home-city.mjs');

const alice = { account: 'alice', tenant: 'tenant-a' };
const bob = { account: 'bob', tenant: 'tenant-a' };

test('常驻城市按 tenant/account 隔离并可读回', () => {
  assert.equal(readHomeCity(alice), null);
  assert.ok(validHomeCity('广州'));
  assert.equal(writeHomeCity(alice, '广州').homeCity, '广州');
  assert.equal(readHomeCity(alice).homeCity, '广州');
  assert.equal(readHomeCity(bob), null, '同账套的另一账号不能读到 Alice 的记忆');
});

test('无效常驻城市不写入，损坏文件 fail closed', () => {
  assert.equal(validHomeCity(''), false);
  assert.equal(validHomeCity('a\ncity'), false);
  assert.equal(writeHomeCity(alice, ''), null);

  fs.writeFileSync(homeCityFile(), '{not-json');
  assert.equal(readHomeCity(alice), null);
  assert.equal(writeHomeCity(alice, '深圳'), null, '损坏文件不能被静默覆盖');
  assert.equal(fs.readFileSync(homeCityFile(), 'utf8'), '{not-json');
});
