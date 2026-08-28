import { ApiExtraModels, ApiProperty, ApiPropertyOptional, getSchemaPath } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsObject, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import {
  ImageCampaignContentInputDto,
  type CampaignContentInputDto,
  TextCampaignContentInputDto,
} from './campaign-content.dto';

export enum CampaignScheduleType {
  IMMEDIATE = 'IMMEDIATE',
  ONCE = 'ONCE',
}

@ApiExtraModels(
  TextCampaignContentInputDto,
  ImageCampaignContentInputDto,
)
export class CreateCampaignDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  sessionId!: string;

  @ApiProperty({ maxLength: 120 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({
    maxLength: 4096,
    deprecated: true,
    description: 'Legacy text input. Use content instead; exactly one of text or content is required.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  text?: string;

  @ApiPropertyOptional({
    description: 'Typed campaign content. Exactly one of content or the legacy text field is required.',
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

  @ApiPropertyOptional({ enum: CampaignScheduleType, default: CampaignScheduleType.IMMEDIATE })
  @IsOptional()
  @IsEnum(CampaignScheduleType)
  scheduleType: CampaignScheduleType = CampaignScheduleType.IMMEDIATE;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: 'Required for ONCE. Ignored and returned as null for IMMEDIATE.',
  })
  @IsOptional()
  @IsString()
  scheduledAt?: string;
}
