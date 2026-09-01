import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const comparisonKey = randomBytes(32);

export function secureStringEqual(left: string | undefined, right: string): boolean {
  if (left === undefined) return false;
  const digest = (value: string): Buffer => createHmac('sha256', comparisonKey)
    .update(value, 'utf8')
    .digest();
  return timingSafeEqual(digest(left), digest(right));
}
