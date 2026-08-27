import { createHash, timingSafeEqual } from 'node:crypto';

export function secureStringEqual(left: string | undefined, right: string): boolean {
  if (left === undefined) return false;
  const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(left), digest(right));
}
