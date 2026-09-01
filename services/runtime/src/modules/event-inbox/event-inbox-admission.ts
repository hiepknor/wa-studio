import { SHA256_HMAC_SIGNATURE_BYTES } from '../../core/security/hmac-signature';
import type { EventInboxReadiness } from './event-inbox.repository';

export interface EventInboxWebhookAdmission {
  available: boolean;
  eventSlotsRemaining: number;
  byteHeadroom: number;
  requiredByteHeadroom: number;
}

export function eventInboxWebhookAdmission(
  readiness: Pick<EventInboxReadiness,
    'storedEvents' | 'storedBytes' | 'maxStoredEvents' | 'maxStoredBytes'>,
  maximumPayloadBytes: number,
): EventInboxWebhookAdmission {
  const eventSlotsRemaining = Math.max(0, readiness.maxStoredEvents - readiness.storedEvents);
  const byteHeadroom = Math.max(0, readiness.maxStoredBytes - readiness.storedBytes);
  const requiredByteHeadroom = maximumPayloadBytes + SHA256_HMAC_SIGNATURE_BYTES;
  return {
    available: eventSlotsRemaining > 0 && byteHeadroom >= requiredByteHeadroom,
    eventSlotsRemaining,
    byteHeadroom,
    requiredByteHeadroom,
  };
}
