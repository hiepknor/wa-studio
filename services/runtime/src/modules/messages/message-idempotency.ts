import { createHash } from 'node:crypto';
import { CampaignContentType, type CampaignContentDto } from '../../contracts/campaigns/campaign-content.dto';

export function messageRequestHash(input: {
  sessionId: string;
  recipientId: string;
  text?: string;
  content?: CampaignContentDto;
  scheduledAt: string | null;
  dryRun: boolean;
}): string {
  const scheduledAt = input.scheduledAt ? new Date(input.scheduledAt).toISOString() : '';
  const content = input.content ?? { type: CampaignContentType.TEXT, text: input.text ?? '' };
  const contentIdentity = content.type === CampaignContentType.TEXT
    ? content.text
    : `\0IMAGE\0${JSON.stringify({
        type: content.type,
        mediaAssetId: content.mediaAssetId,
        caption: content.caption ?? '',
        filename: content.filename,
        mimeType: content.mimeType,
        byteSize: content.byteSize,
        sha256: content.sha256,
      })}`;
  return createHash('sha256').update([
    input.sessionId,
    input.recipientId,
    contentIdentity,
    scheduledAt,
    String(input.dryRun),
  ].join('\n')).digest('hex');
}
