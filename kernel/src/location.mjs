import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validHomeCity } from './home-city.mjs';

const execFileAsync = promisify(execFile);
const IP_LOCATION_URL = 'https://ipwho.is/';
const CURL_TIMEOUT_MS = 5_000;
const CURL_MAX_BUFFER = 64 * 1024;

const validCoordinate = (value, min, max) => typeof value === 'number'
  && Number.isFinite(value) && value >= min && value <= max;

/**
 * 只保留城市级候选。公网 IP 的位置只是参考，不能直接成为员工常驻城市。
 * 坐标用于证明响应是完整的位置结果，但不会被报销账本持久化。
 */
export function normalizeIpLocation(payload) {
  const city = typeof payload?.city === 'string' ? payload.city.trim() : '';
  const latitude = payload?.latitude;
  const longitude = payload?.longitude;
  if (!validHomeCity(city)
    || ['unknown', 'n/a', 'na', '-'].includes(city.toLowerCase())
    || !validCoordinate(latitude, -90, 90)
    || !validCoordinate(longitude, -180, 180)) return null;
  return {
    city,
    latitude,
    longitude,
    source: 'ip',
    precision: 'city',
  };
}

/**
 * 通过固定的 HTTPS endpoint 获取公网 IP 的城市级位置。
 * 失败时返回 null，让首次常驻城市步骤回到原有手动填写路径。
 */
export async function lookupNetworkLocation({
  command = process.env.BAOX_LOCATION_CURL ?? 'curl',
  execFileFn = execFileAsync,
} = {}) {
  try {
    const { stdout } = await execFileFn(command, [
      '--fail',
      '--silent',
      '--show-error',
      '--connect-timeout',
      '3',
      '--max-time',
      '5',
      '--noproxy',
      '*',
      '--header',
      'Accept: application/json',
      '--user-agent',
      'baox/1.1',
      IP_LOCATION_URL,
    ], { timeout: CURL_TIMEOUT_MS + 500, maxBuffer: CURL_MAX_BUFFER });
    return normalizeIpLocation(JSON.parse(stdout));
  } catch {
    return null;
  }
}

export { IP_LOCATION_URL };
