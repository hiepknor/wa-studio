import { describe, expect, it } from 'vitest';
import {
  emissionIntervalMs,
  messageBucketPolicies,
  messageSafetyPolicy,
} from '../../src/integrations/openwa/safety/openwa-safety-policy';
import { openWAUpstreamId } from '../../src/integrations/openwa/safety/openwa-safety-governor.service';

describe('OpenWA safety policy', () => {
  it('starts new workspaces with the conservative canary envelope', () => {
    const policy = messageSafetyPolicy('CANARY');
    expect(policy).toMatchObject({
      minuteLimit: 3,
      hourLimit: 20,
      dayLimit: 50,
      recipientLimit: 1,
      imageCost: 2,
    });
    expect(policy.pacingMs.MESSAGE_SEND_TEXT).toBe(15_000);
    expect(policy.pacingMs.MESSAGE_SEND_IMAGE).toBe(20_000);
  });

  it('charges images twice against session windows but once against the upstream HTTP budget', () => {
    const policies = messageBucketPolicies('CANARY', 'MESSAGE_SEND_IMAGE');
    expect(policies.filter(policy => policy.scopeType === 'UPSTREAM').every(policy => policy.cost === 1)).toBe(true);
    expect(policies.filter(policy => policy.operationClass === 'MESSAGE_SEND_ALL'
      && policy.windowName !== 'PACING')
      .every(policy => policy.cost === 2)).toBe(true);
  });

  it('shares pacing and rate windows across text and image sends', () => {
    const text = messageBucketPolicies('STANDARD', 'MESSAGE_SEND_TEXT');
    const image = messageBucketPolicies('STANDARD', 'MESSAGE_SEND_IMAGE');
    for (const windowName of ['PACING', 'MINUTE', 'HOUR', 'DAY'] as const) {
      expect(text).toContainEqual(expect.objectContaining({
        scopeType: 'SESSION', operationClass: 'MESSAGE_SEND_ALL', windowName,
      }));
      expect(image).toContainEqual(expect.objectContaining({
        scopeType: 'SESSION', operationClass: 'MESSAGE_SEND_ALL', windowName,
      }));
    }
    expect(image).toContainEqual(expect.objectContaining({
      scopeType: 'SESSION', operationClass: 'MESSAGE_SEND_IMAGE', windowName: 'PACING',
      periodMs: 15_000,
    }));
  });

  it('uses ceiling division so a configured bucket never exceeds its limit', () => {
    const minute = messageBucketPolicies('STANDARD', 'MESSAGE_SEND_TEXT')
      .find(policy => policy.operationClass === 'MESSAGE_SEND_ALL' && policy.windowName === 'MINUTE')!;
    expect(emissionIntervalMs(minute)).toBe(12_000);
  });

  it('keys safety state by normalized upstream origin without persisting the origin', () => {
    expect(openWAUpstreamId('https://openwa.example.test/path')).toBe(
      openWAUpstreamId('https://openwa.example.test'),
    );
    expect(openWAUpstreamId('https://other.example.test')).not.toBe(
      openWAUpstreamId('https://openwa.example.test'),
    );
  });
});
