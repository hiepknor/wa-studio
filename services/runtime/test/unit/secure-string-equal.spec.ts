import { describe, expect, it } from 'vitest';
import { secureStringEqual } from '../../src/core/security/secure-string-equal';

describe('secureStringEqual', () => {
  it('accepts only the exact UTF-8 value', () => {
    expect(secureStringEqual('runtime-key-đúng', 'runtime-key-đúng')).toBe(true);
    expect(secureStringEqual('runtime-key-dung', 'runtime-key-đúng')).toBe(false);
    expect(secureStringEqual('runtime-key-đúng-extra', 'runtime-key-đúng')).toBe(false);
    expect(secureStringEqual(undefined, 'runtime-key-đúng')).toBe(false);
  });
});
