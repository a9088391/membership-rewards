import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify<string, Buffer, number, { N: number; r: number; p: number; maxmem: number }, Buffer>(scrypt);
const options = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const dummySalt = randomBytes(16);

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, 32, options);
  return 'scrypt:' + salt.toString('hex') + ':' + hash.toString('hex');
}

export async function matchesPassword(password: string, stored?: string): Promise<boolean> {
  // 不存在的帳號也執行等成本的 scrypt。
  const parts = stored?.match(/^scrypt:([a-f0-9]{32}):([a-f0-9]{64})$/);
  const salt = parts ? Buffer.from(parts[1], 'hex') : dummySalt;
  const expected = parts ? Buffer.from(parts[2], 'hex') : Buffer.alloc(32);
  const hash = await derive(password, salt, 32, options);
  return timingSafeEqual(hash, expected) && Boolean(parts);
}
