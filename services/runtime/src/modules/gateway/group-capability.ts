import { normalizeContactIdentity } from '../contacts/contact-normalization';

export type GroupSendCapabilityStatus = 'ALLOWED' | 'DENIED' | 'UNKNOWN';

export type GroupSendCapabilityReason =
  | 'SEND_ALLOWED'
  | 'GROUP_INACTIVE'
  | 'GROUP_READ_ONLY'
  | 'ADMIN_ONLY'
  | 'ADMIN_STATUS_UNKNOWN'
  | 'METADATA_INCOMPLETE'
  | 'GROUP_CHANGED'
  | 'GATEWAY_PERMISSION_DENIED'
  | 'MANUAL_REFRESH'
  | 'REFRESH_FAILED';

export interface GroupCapabilityInput {
  isActive: boolean;
  isReadOnly: boolean | null;
  isAnnounce: boolean | null;
  isAdmin: boolean | null;
  hasDetails: boolean;
}

export interface GroupCapabilityDecision {
  status: GroupSendCapabilityStatus;
  reason: GroupSendCapabilityReason;
}

export interface GroupParticipantAdminEvidence {
  id: string;
  number: string;
  isAdmin: boolean;
  isSuperAdmin: boolean;
}

function normalizedPhone(value: string | null | undefined): string | null {
  const candidate = value?.trim().replace(/^\+/u, '');
  if (!candidate) return null;
  const identity = normalizeContactIdentity(
    candidate.includes('@') ? candidate : `${candidate}@c.us`,
  );
  return identity.phone;
}

export function inferSessionAdminStatus(
  sessionPhone: string | null | undefined,
  participants: readonly GroupParticipantAdminEvidence[],
): boolean | null {
  const phone = normalizedPhone(sessionPhone);
  if (!phone) return null;
  const matches = participants.filter(participant =>
    normalizedPhone(participant.number) === phone
      || normalizedPhone(participant.id) === phone,
  );
  if (matches.length === 0) return null;
  return matches.some(participant => participant.isAdmin || participant.isSuperAdmin);
}

export function evaluateGroupCapability(input: GroupCapabilityInput): GroupCapabilityDecision {
  if (!input.isActive) return { status: 'DENIED', reason: 'GROUP_INACTIVE' };
  if (!input.hasDetails) return { status: 'UNKNOWN', reason: 'METADATA_INCOMPLETE' };
  if (input.isReadOnly === true) return { status: 'DENIED', reason: 'GROUP_READ_ONLY' };
  if (input.isAnnounce === true && input.isAdmin === false) {
    return { status: 'DENIED', reason: 'ADMIN_ONLY' };
  }
  if (input.isAnnounce === true && input.isAdmin === null) {
    return { status: 'UNKNOWN', reason: 'ADMIN_STATUS_UNKNOWN' };
  }
  if (input.isAnnounce === true && input.isAdmin === true) {
    return { status: 'ALLOWED', reason: 'SEND_ALLOWED' };
  }
  if (input.isAnnounce === false && input.isReadOnly === false) {
    return { status: 'ALLOWED', reason: 'SEND_ALLOWED' };
  }
  return { status: 'UNKNOWN', reason: 'METADATA_INCOMPLETE' };
}
