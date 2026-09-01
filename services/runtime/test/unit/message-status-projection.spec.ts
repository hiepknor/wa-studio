import { describe, expect, it } from 'vitest';
import {
  messageStatusFromEvent,
  nextProjectedMessageStatus,
} from '../../src/modules/messages/message-status-projection.service';

describe('message status projection policy', () => {
  it('normalizes supported OpenWA status events', () => {
    expect(messageStatusFromEvent('message.sent', null)).toBe('SENT');
    expect(messageStatusFromEvent('message.failed', null)).toBe('FAILED');
    expect(messageStatusFromEvent('message.ack', 'DELIVERED')).toBe('DELIVERED');
    expect(messageStatusFromEvent('message.ack', 'read')).toBe('READ');
    expect(messageStatusFromEvent('message.ack', 'unknown')).toBeNull();
  });

  it('advances delivery status monotonically', () => {
    expect(nextProjectedMessageStatus('ACCEPTED', 'DELIVERED')).toBe('DELIVERED');
    expect(nextProjectedMessageStatus('READ', 'DELIVERED')).toBe('READ');
    expect(nextProjectedMessageStatus('DELIVERED', 'FAILED')).toBe('DELIVERED');
    expect(nextProjectedMessageStatus('UNKNOWN', 'SENT')).toBe('SENT');
    expect(nextProjectedMessageStatus('ACCEPTED', 'FAILED')).toBe('FAILED');
    expect(nextProjectedMessageStatus('CANCELLED', 'READ')).toBe('CANCELLED');
  });
});
