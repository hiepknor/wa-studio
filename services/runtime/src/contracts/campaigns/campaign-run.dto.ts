import { ApiExtraModels, ApiProperty, getSchemaPath } from '@nestjs/swagger';
import { IsEnum, IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';
import { PageMetaDto } from '../common/pagination.dto';
import { CampaignExecutionMode, CampaignPreflightDto } from './campaign-preflight.dto';
import { CampaignTargetSourceDto } from './campaign-target.dto';
import {
  ImageCampaignContentDto,
  type CampaignContentDto,
  TextCampaignContentDto,
} from './campaign-content.dto';

export enum CampaignRunStatus {
  PREPARING = 'PREPARING',
  BLOCKED = 'BLOCKED',
  SCHEDULED = 'SCHEDULED',
  RUNNING = 'RUNNING',
  PAUSED = 'PAUSED',
  COMPLETED = 'COMPLETED',
  PARTIAL_FAILED = 'PARTIAL_FAILED',
  CANCELLED = 'CANCELLED',
  FAILED = 'FAILED',
}

export class CreateCampaignRunDto {
  @ApiProperty({ enum: CampaignExecutionMode, default: CampaignExecutionMode.DRY_RUN })
  @IsEnum(CampaignExecutionMode)
  executionMode!: CampaignExecutionMode;

  @ApiProperty({
    type: 'integer', minimum: 1, required: false,
    description: 'Campaign content revision to launch. A stale value returns HTTP 409.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedCampaignRevision?: number;

  @ApiProperty({
    type: 'integer', minimum: 0, required: false,
    description: 'Campaign target revision to launch. A stale value returns HTTP 409.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedTargetsRevision?: number;

  @ApiProperty({
    required: false,
    minLength: 32,
    maxLength: 2048,
    description: 'Signed token returned by the matching LIVE preflight. Required when executionMode is LIVE.',
  })
  @IsOptional()
  @IsString()
  @MinLength(32)
  @MaxLength(2048)
  preflightToken?: string;
}

export class CampaignRunProgressDto {
  @ApiProperty() total!: number;
  @ApiProperty() pending!: number;
  @ApiProperty() materialized!: number;
  @ApiProperty() processing!: number;
  @ApiProperty() dryRunCompleted!: number;
  @ApiProperty() accepted!: number;
  @ApiProperty() sent!: number;
  @ApiProperty() delivered!: number;
  @ApiProperty() read!: number;
  @ApiProperty() failed!: number;
  @ApiProperty() unknown!: number;
  @ApiProperty() blocked!: number;
  @ApiProperty() cancelled!: number;
}

@ApiExtraModels(TextCampaignContentDto, ImageCampaignContentDto)
export class CampaignRunDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  campaignId!: string;

  @ApiProperty()
  campaignNameSnapshot!: string;

  @ApiProperty({ format: 'uuid' })
  sessionId!: string;

  @ApiProperty({ enum: CampaignExecutionMode })
  executionMode!: CampaignExecutionMode;

  @ApiProperty({ enum: CampaignRunStatus })
  status!: CampaignRunStatus;

  @ApiProperty({ type: String, nullable: true })
  statusReason!: string | null;

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

  @ApiProperty({ type: CampaignTargetSourceDto, nullable: true })
  targetSource!: CampaignTargetSourceDto | null;

  @ApiProperty({ type: CampaignPreflightDto, nullable: true })
  preflight!: CampaignPreflightDto | null;

  @ApiProperty({ minimum: 1 })
  campaignRevision!: number;

  @ApiProperty({ minimum: 0 })
  targetsRevision!: number;

  @ApiProperty()
  totalTargets!: number;

  @ApiProperty({ type: CampaignRunProgressDto })
  progress!: CampaignRunProgressDto;

  @ApiProperty({ format: 'date-time' })
  scheduledAt!: Date;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  startedAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  completedAt!: Date | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}

export class CampaignRunSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) campaignId!: string;
  @ApiProperty() campaignNameSnapshot!: string;
  @ApiProperty({ format: 'uuid' }) sessionId!: string;
  @ApiProperty({ enum: CampaignExecutionMode }) executionMode!: CampaignExecutionMode;
  @ApiProperty({ enum: CampaignRunStatus }) status!: CampaignRunStatus;
  @ApiProperty({ type: String, nullable: true }) statusReason!: string | null;
  @ApiProperty() totalTargets!: number;
  @ApiProperty({ type: CampaignRunProgressDto }) progress!: CampaignRunProgressDto;
  @ApiProperty({ format: 'date-time' }) scheduledAt!: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) startedAt!: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) completedAt!: Date | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ format: 'date-time' }) updatedAt!: Date;
}

export class CampaignRunSummaryListDto {
  @ApiProperty({ type: [CampaignRunSummaryDto] }) data!: CampaignRunSummaryDto[];
  @ApiProperty({ type: PageMetaDto }) meta!: PageMetaDto;
}

export class CampaignRunListDto {
  @ApiProperty({ type: [CampaignRunDto] })
  data!: CampaignRunDto[];

  @ApiProperty({ type: PageMetaDto })
  meta!: PageMetaDto;
}
