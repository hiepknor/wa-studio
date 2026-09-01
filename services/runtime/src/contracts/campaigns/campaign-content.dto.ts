import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum CampaignContentType {
  TEXT = 'TEXT',
  IMAGE = 'IMAGE',
}

export class TextCampaignContentInputDto {
  @ApiProperty({ enum: [CampaignContentType.TEXT] })
  type!: CampaignContentType.TEXT;

  @ApiProperty({ maxLength: 4096 })
  text!: string;
}

export class ImageCampaignContentInputDto {
  @ApiProperty({ enum: [CampaignContentType.IMAGE] })
  type!: CampaignContentType.IMAGE;

  @ApiProperty({ format: 'uuid' })
  mediaAssetId!: string;

  @ApiPropertyOptional({ maxLength: 1024, default: '' })
  caption?: string;
}

export type CampaignContentInputDto =
  | TextCampaignContentInputDto
  | ImageCampaignContentInputDto;

export class TextCampaignContentDto extends TextCampaignContentInputDto {}

export class ImageCampaignContentDto extends ImageCampaignContentInputDto {
  @ApiProperty({ maxLength: 255 })
  filename!: string;

  @ApiProperty({ maxLength: 127 })
  mimeType!: string;

  @ApiProperty({ minimum: 1, maximum: 8_388_608 })
  byteSize!: number;

  @ApiProperty({ pattern: '^[0-9a-f]{64}$' })
  sha256!: string;
}

export type CampaignContentDto =
  | TextCampaignContentDto
  | ImageCampaignContentDto;

export const campaignContentText = (content: CampaignContentDto): string =>
  content.type === CampaignContentType.TEXT ? content.text : content.caption ?? '';

export const campaignContentMediaAssetId = (content: CampaignContentDto): string | null =>
  content.type === CampaignContentType.TEXT ? null : content.mediaAssetId;

export const campaignContentMessageType = (content: CampaignContentDto): 'text' | 'image' =>
  content.type.toLowerCase() as 'text' | 'image';

export function campaignContentFromPayload(payload: unknown): CampaignContentDto {
  if (!payload || typeof payload !== 'object') throw new Error('Stored campaign content is invalid');
  const value = payload as Record<string, unknown>;
  const type = value.type ?? (typeof value.text === 'string' ? CampaignContentType.TEXT : undefined);
  if (type === CampaignContentType.TEXT && typeof value.text === 'string') {
    return { type, text: value.text };
  }
  if (type === CampaignContentType.IMAGE
    && typeof value.mediaAssetId === 'string'
    && typeof value.filename === 'string'
    && typeof value.mimeType === 'string'
    && typeof value.byteSize === 'number'
    && typeof value.sha256 === 'string') {
    return {
      type,
      mediaAssetId: value.mediaAssetId,
      caption: typeof value.caption === 'string' ? value.caption : '',
      filename: value.filename,
      mimeType: value.mimeType,
      byteSize: value.byteSize,
      sha256: value.sha256,
    };
  }
  throw new Error('Stored campaign content is invalid');
}
