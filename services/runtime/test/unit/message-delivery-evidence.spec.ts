import { describe, expect, it } from 'vitest';
import {
  connectorJobStatusTransitions,
  nextTransportState,
  safetyOutcomeFromConnectorEvidence,
  transportStateFromEvidence,
} from '../../src/modules/messages/message-delivery-evidence.service';

describe('connector delivery evidence reducer', () => {
  it('keeps Runtime dispatch distinct from the plugin send ambiguity boundary', () => {
    expect(transportStateFromEvidence('COMMAND_RECEIVED')).toBe('INGRESS_ACCEPTED');
    expect(transportStateFromEvidence('SEND_STARTED')).toBe('SEND_STARTED');
    expect(nextTransportState('DISPATCH_STARTED', 'INGRESS_ACCEPTED')).toBe('INGRESS_ACCEPTED');
    expect(nextTransportState('INGRESS_ACCEPTED', 'SEND_STARTED')).toBe('SEND_STARTED');
  });

  it('reduces delivery progress monotonically and preserves terminal outcomes', () => {
    expect(nextTransportState('SEND_STARTED', 'SEND_ACCEPTED')).toBe('SEND_ACCEPTED');
    expect(nextTransportState('DELIVERED', 'SENT')).toBe('DELIVERED');
    expect(nextTransportState('READ', 'FAILED_DEFINITIVE')).toBe('READ');
    expect(nextTransportState('FAILED_DEFINITIVE', 'READ')).toBe('FAILED_DEFINITIVE');
  });

  it('retains an indeterminate result until stronger evidence resolves it', () => {
    expect(nextTransportState('SEND_STARTED', 'INDETERMINATE')).toBe('INDETERMINATE');
    expect(nextTransportState('INDETERMINATE', 'SEND_STARTED')).toBe('INDETERMINATE');
    expect(nextTransportState('INDETERMINATE', 'SEND_ACCEPTED')).toBe('SEND_ACCEPTED');
    expect(nextTransportState('INDETERMINATE', 'FAILED_DEFINITIVE')).toBe('FAILED_DEFINITIVE');
  });

  it('bridges skipped acknowledgements without illegal job transitions', () => {
    expect(connectorJobStatusTransitions('PROCESSING', 'ACK_DELIVERED'))
      .toEqual(['ACCEPTED', 'DELIVERED']);
    expect(connectorJobStatusTransitions('UNKNOWN', 'SEND_ACCEPTED')).toEqual(['ACCEPTED']);
    expect(connectorJobStatusTransitions('SENT', 'ACK_FAILED')).toEqual([]);
    expect(connectorJobStatusTransitions('PROCESSING', 'SEND_INDETERMINATE')).toEqual(['UNKNOWN']);
  });

  it('feeds connector terminal evidence back into the global safety governor', () => {
    expect(safetyOutcomeFromConnectorEvidence({ kind: 'SEND_ACCEPTED', errorClass: null }))
      .toEqual({ kind: 'SUCCESS' });
    expect(safetyOutcomeFromConnectorEvidence({ kind: 'SEND_REJECTED', errorClass: 'RATE_LIMITED' }))
      .toEqual({ kind: 'RATE_LIMITED' });
    expect(safetyOutcomeFromConnectorEvidence({
      kind: 'SEND_REJECTED', errorClass: 'SESSION_RESTRICTED',
    })).toEqual({ kind: 'SESSION_RESTRICTED' });
    expect(safetyOutcomeFromConnectorEvidence({ kind: 'SEND_INDETERMINATE', errorClass: 'AMBIGUOUS' }))
      .toEqual({ kind: 'AMBIGUOUS' });
    expect(safetyOutcomeFromConnectorEvidence({ kind: 'ACK_FAILED', errorClass: null }))
      .toEqual({ kind: 'TRANSIENT_FAILURE' });
    expect(safetyOutcomeFromConnectorEvidence({ kind: 'SEND_STARTED', errorClass: null })).toBeNull();
  });
});
