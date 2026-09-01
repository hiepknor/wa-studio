import { ApiExtraModels, ApiPropertyOptional, getSchemaPath } from '@nestjs/swagger';
import { IsEnum, IsInt, IsNotEmpty, IsObject, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { CampaignScheduleType } from './create-campaign.dto';
import {
  ImageCampaignContentInputDto,
  type CampaignContentInputDto,
  TextCampaignContentInputDto,
} from './campaign-content.dto';

@ApiExtraModels(
  TextCampaignContentInputDto,
  ImageCampaignContentInputDto,
)
export class UpdateCampaignDto {
  @ApiPropertyOptional({
    type: 'integer', minimum: 1,
    description: 'Campaign revision observed by the editor. A stale value returns HTTP 409.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedRevision?: number;

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({
    maxLength: 4096,
    deprecated: true,
    description: 'Legacy text update. Use content instead; text and content cannot be supplied together.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  text?: string;

  @ApiPropertyOptional({
    oneOf: [
      { $ref: getSchemaPath(TextCampaignContentInputDto) },
      { $ref: getSchemaPath(ImageCampaignContentInputDto) },
    ],
    discriminator: {
      propertyName: 'type',
      mapping: {
        TEXT: getSchemaPath(TextCampaignContentInputDto),
        IMAGE: getSchemaPath(ImageCampaignContentInputDto),
      },
    },
  })
  @IsOptional()
  @IsObject()
  content?: CampaignContentInputDto;

  @ApiPropertyOptional({ enum: CampaignScheduleType })
  @IsOptional()
  @IsEnum(CampaignScheduleType)
  scheduleType?: CampaignScheduleType;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Required when changing to ONCE; null is the canonical value for IMMEDIATE.',
  })
  @IsOptional()
  @IsString()
  scheduledAt?: string | null;
}
