import { timingSafeEqual } from 'node:crypto';

export function secureStringEqual(left: string | undefined, right: string): boolean {
  if (left === undefined) return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
