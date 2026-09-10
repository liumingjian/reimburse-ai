import fs from 'node:fs';
import path from 'node:path';
import { paths, writeJsonAtomic } from './paths.mjs';

const homeCityFile = () => path.join(paths.root, 'home-cities.json');

const identityKey = (identity) => identity?.account && identity?.tenant
  ? JSON.stringify([identity.tenant, identity.account]) : null;

const readRecords = () => {
  try {
    const parsed = JSON.parse(fs.readFileSync(homeCityFile(), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch (error) {
    return error.code === 'ENOENT' ? {} : null;
  }
};

export const validHomeCity = (value) => typeof value === 'string'
  && value.trim().length > 0 && value.trim().length <= 20
  && !/[\u0000-\u001f\u007f]/.test(value);

export function readHomeCity(identity) {
  const key = identityKey(identity);
  const records = readRecords();
  if (!key || !records) return null;
  const record = records[key];
  return validHomeCity(record?.homeCity) ? { ...record, homeCity: record.homeCity.trim() } : null;
}

/**
 * 写员工记忆时对损坏的文件 fail closed。缺失文件可以创建，损坏文件不能静默覆盖，
 * 否则会把另一个身份的记忆当成不存在。
 */
export function writeHomeCity(identity, homeCity) {
  const key = identityKey(identity);
  if (!key || !validHomeCity(homeCity)) return null;
  const records = readRecords();
  if (!records) return null;
  const record = { homeCity: homeCity.trim(), confirmedAt: new Date().toISOString() };
  writeJsonAtomic(homeCityFile(), { ...records, [key]: record });
  return record;
}

export { homeCityFile };
