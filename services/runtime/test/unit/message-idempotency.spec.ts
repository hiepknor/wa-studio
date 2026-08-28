import { describe, expect, it } from 'vitest';
import {
  CampaignContentType,
  type ImageCampaignContentDto,
} from '../../src/contracts/campaigns/campaign-content.dto';
import { messageRequestHash } from '../../src/modules/messages/message-idempotency';

const intent = {
  sessionId: 'session-1',
  recipientId: 'group@g.us',
  text: 'hello',
  scheduledAt: null,
  dryRun: true,
};

describe('messageRequestHash', () => {
  it('is stable for the same intent', () => {
    expect(messageRequestHash(intent)).toBe(messageRequestHash({ ...intent }));
  });

  it('changes when an idempotent request changes meaning', () => {
    expect(messageRequestHash(intent)).not.toBe(messageRequestHash({ ...intent, text: 'different' }));
    expect(messageRequestHash(intent)).not.toBe(messageRequestHash({ ...intent, dryRun: false }));
  });

  it('preserves the legacy text hash while domain-separating immutable image snapshots', () => {
    const typedText = messageRequestHash({
      ...intent,
      text: undefined,
      content: { type: CampaignContentType.TEXT, text: intent.text },
    });
    const image: ImageCampaignContentDto = {
      type: CampaignContentType.IMAGE,
      mediaAssetId: '22222222-2222-4222-8222-222222222222',
      caption: intent.text,
      filename: 'launch.png',
      mimeType: 'image/png',
      byteSize: 8,
      sha256: 'a'.repeat(64),
    };
    expect(typedText).toBe(messageRequestHash(intent));
    expect(messageRequestHash({ ...intent, text: undefined, content: image }))
      .not.toBe(messageRequestHash(intent));
    expect(messageRequestHash({
      ...intent,
      text: undefined,
      content: { ...image, caption: 'different' },
    })).not.toBe(messageRequestHash({ ...intent, text: undefined, content: image }));
  });
});
