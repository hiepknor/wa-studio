import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';

export enum CampaignExecutionMode {
  DRY_RUN = 'DRY_RUN',
  LIVE = 'LIVE',
}

export enum CampaignPreflightStatus {
  PASS = 'PASS',
  WARN = 'WARN',
  BLOCK = 'BLOCK',
}

export enum CampaignPreflightCheckCode {
  CONTENT_VALID = 'CONTENT_VALID',
  MEDIA_READY = 'MEDIA_READY',
  TARGETS_VALID = 'TARGETS_VALID',
  SESSION_SENDABLE = 'SESSION_SENDABLE',
  GROUP_CAPABILITY = 'GROUP_CAPABILITY',
  LIVE_SEND_ALLOWED = 'LIVE_SEND_ALLOWED',
  SAFETY_READY = 'SAFETY_READY',
}

export enum CampaignTargetIssueReason {
  TARGET_CAPABILITY_DENIED = 'TARGET_CAPABILITY_DENIED',
  TARGET_CAPABILITY_UNKNOWN = 'TARGET_CAPABILITY_UNKNOWN',
  TARGET_CAPABILITY_STALE = 'TARGET_CAPABILITY_STALE',
}

export class CampaignPreflightRequestDto {
  @ApiProperty({ enum: CampaignExecutionMode, default: CampaignExecutionMode.DRY_RUN })
  @IsEnum(CampaignExecutionMode)
  executionMode!: CampaignExecutionMode;
}

export class CampaignPreflightCheckDto {
  @ApiProperty({ enum: CampaignPreflightCheckCode })
  code!: CampaignPreflightCheckCode;

  @ApiProperty({ enum: CampaignPreflightStatus })
  status!: CampaignPreflightStatus;

  @ApiProperty()
  message!: string;
}

export class CampaignTargetIssueDto {
  @ApiProperty()
  groupId!: string;

  @ApiProperty()
  groupName!: string;

  @ApiProperty({ enum: ['ALLOWED', 'DENIED', 'UNKNOWN'] })
  capability!: string;

  @ApiProperty({ enum: CampaignTargetIssueReason })
  reason!: CampaignTargetIssueReason;
}

export class CampaignSafetyForecastDto {
  @ApiProperty({
    enum: ['READY', 'WAITING', 'BLOCKED'],
    description: 'Current admission posture. This is not a delivery guarantee.',
  })
  status!: string;

  @ApiProperty({ type: String, nullable: true })
  reason!: string | null;

  @ApiProperty() targetCount!: number;
  @ApiProperty() messageUnits!: number;
  @ApiProperty() queuedMessagesAhead!: number;
  @ApiProperty() recipientDeferredTargets!: number;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Estimated first Runtime safety admission, without consuming budget.',
  })
  estimatedFirstAdmissionAt!: Date | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Estimated last Runtime safety admission, not message delivery time.',
  })
  estimatedLastAdmissionAt!: Date | null;

  @ApiProperty({ type: Number, nullable: true })
  estimatedSpanSeconds!: number | null;

  @ApiProperty({ format: 'date-time' })
  calculatedAt!: Date;
}

export class CampaignPreflightDto {
  @ApiProperty({ enum: CampaignPreflightStatus })
  status!: CampaignPreflightStatus;

  @ApiProperty()
  policyVersion!: number;

  @ApiProperty({ minimum: 1 })
  campaignRevision!: number;

  @ApiProperty({ minimum: 0 })
  targetsRevision!: number;

  @ApiProperty({ enum: CampaignExecutionMode })
  executionMode!: CampaignExecutionMode;

  @ApiProperty({ format: 'date-time' })
  checkedAt!: Date;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Short-lived signed proof required to launch this reviewed LIVE snapshot.',
  })
  liveLaunchToken?: string | null;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Expiry of liveLaunchToken. Null for DRY_RUN or a blocked LIVE preflight.',
  })
  liveLaunchTokenExpiresAt?: Date | null;

  @ApiProperty()
  totalTargets!: number;

  @ApiProperty()
  allowedTargets!: number;

  @ApiProperty()
  deniedTargets!: number;

  @ApiProperty()
  unknownTargets!: number;

  @ApiProperty({ type: [CampaignPreflightCheckDto] })
  checks!: CampaignPreflightCheckDto[];

  @ApiProperty({ type: [CampaignTargetIssueDto] })
  targetIssues!: CampaignTargetIssueDto[];

  @ApiPropertyOptional({
    type: CampaignSafetyForecastDto,
    description: 'Read-only LIVE admission estimate. Omitted for dry-runs and empty target sets.',
  })
  safetyForecast?: CampaignSafetyForecastDto;
}
