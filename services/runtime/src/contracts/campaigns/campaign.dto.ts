import { ApiExtraModels, ApiProperty, getSchemaPath } from '@nestjs/swagger';
import { PageMetaDto } from '../common/pagination.dto';
import {
  ImageCampaignContentDto,
  type CampaignContentDto,
  TextCampaignContentDto,
} from './campaign-content.dto';
import { CampaignScheduleType } from './create-campaign.dto';

export enum CampaignStatus {
  DRAFT = 'DRAFT',
  ACTIVE = 'ACTIVE',
  PAUSED = 'PAUSED',
  ARCHIVED = 'ARCHIVED',
}

@ApiExtraModels(TextCampaignContentDto, ImageCampaignContentDto)
export class CampaignDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  sessionId!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ deprecated: true, description: 'Legacy alias for text content or a media caption.' })
  text!: string;

  @ApiProperty({
    oneOf: [
      { $ref: getSchemaPath(TextCampaignContentDto) },
      { $ref: getSchemaPath(ImageCampaignContentDto) },
    ],
    discriminator: {
      propertyName: 'type',
      mapping: {
        TEXT: getSchemaPath(TextCampaignContentDto),
        IMAGE: getSchemaPath(ImageCampaignContentDto),
      },
    },
  })
  content!: CampaignContentDto;

  @ApiProperty({ enum: CampaignScheduleType })
  scheduleType!: CampaignScheduleType;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  scheduledAt!: Date | null;

  @ApiProperty({ enum: CampaignStatus })
  status!: CampaignStatus;

  @ApiProperty()
  targetCount!: number;

  @ApiProperty({ minimum: 1, description: 'Revision of campaign content and scheduling.' })
  revision!: number;

  @ApiProperty({ minimum: 0, description: 'Revision of the complete target set.' })
  targetsRevision!: number;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}

export class CampaignListPageMetaDto extends PageMetaDto {
  @ApiProperty({ description: 'Total campaigns matching current session scope, search, and filter predicates.' })
  declare total: number;
}

export class CampaignListDto {
  @ApiProperty({ type: [CampaignDto] })
  data!: CampaignDto[];

  @ApiProperty({ type: CampaignListPageMetaDto })
  meta!: CampaignListPageMetaDto;
}
