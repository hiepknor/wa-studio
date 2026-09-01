import { describe, expect, it } from 'vitest';
import {
  evaluateGroupCapability,
  inferSessionAdminStatus,
} from '../../src/modules/gateway/group-capability';

describe('evaluateGroupCapability', () => {
  it.each([
    [{ isActive: false, isReadOnly: false, isAnnounce: false, isAdmin: false, hasDetails: true }, 'DENIED', 'GROUP_INACTIVE'],
    [{ isActive: true, isReadOnly: true, isAnnounce: false, isAdmin: true, hasDetails: true }, 'DENIED', 'GROUP_READ_ONLY'],
    [{ isActive: true, isReadOnly: false, isAnnounce: true, isAdmin: false, hasDetails: true }, 'DENIED', 'ADMIN_ONLY'],
    [{ isActive: true, isReadOnly: false, isAnnounce: true, isAdmin: null, hasDetails: true }, 'UNKNOWN', 'ADMIN_STATUS_UNKNOWN'],
    [{ isActive: true, isReadOnly: false, isAnnounce: true, isAdmin: true, hasDetails: true }, 'ALLOWED', 'SEND_ALLOWED'],
    [{ isActive: true, isReadOnly: false, isAnnounce: false, isAdmin: false, hasDetails: true }, 'ALLOWED', 'SEND_ALLOWED'],
    [{ isActive: true, isReadOnly: null, isAnnounce: null, isAdmin: null, hasDetails: false }, 'UNKNOWN', 'METADATA_INCOMPLETE'],
  ] as const)('maps %j to %s/%s', (input, status, reason) => {
    expect(evaluateGroupCapability(input)).toEqual({ status, reason });
  });

  it.each([
    ['84970000000', [{ id: '84970000000@c.us', number: '84970000000', isAdmin: true, isSuperAdmin: false }], true],
    ['+84970000000', [{ id: '84970000000:7@s.whatsapp.net', number: '84970000000', isAdmin: false, isSuperAdmin: true }], true],
    ['84970000000', [{ id: '84970000000@c.us', number: '84970000000', isAdmin: false, isSuperAdmin: false }], false],
    ['84970000000', [{ id: 'opaque@lid', number: 'opaque', isAdmin: true, isSuperAdmin: false }], null],
    [null, [{ id: '84970000000@c.us', number: '84970000000', isAdmin: true, isSuperAdmin: false }], null],
  ] as const)('infers admin status for session phone %s as %s', (phone, participants, expected) => {
    expect(inferSessionAdminStatus(phone, participants)).toBe(expected);
  });
});
