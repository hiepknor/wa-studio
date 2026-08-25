import { ApiProperty } from '@nestjs/swagger';

export enum ActivityCategory {
  RUN = 'RUN',
  CAMPAIGN = 'CAMPAIGN',
  SYNC = 'SYNC',
  SESSION = 'SESSION',
}

export enum ActivitySeverity {
  INFO = 'INFO',
  SUCCESS = 'SUCCESS',
  WARNING = 'WARNING',
  ERROR = 'ERROR',
}

export enum ActivityOrigin {
  STUDIO = 'STUDIO',
  RUNTIME = 'RUNTIME',
  GATEWAY = 'GATEWAY',
}

export class ActivitySubjectDto {
  @ApiProperty() type!: string;
  @ApiProperty() id!: string;
  @ApiProperty() labelSnapshot!: string;
}

export class ActivityRelatedDto {
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) campaignId!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) runId!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) syncRunId!: string | null;
  @ApiProperty({ type: String, nullable: true }) groupId!: string | null;
}

export class ActivityEventDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) sessionId!: string;
  @ApiProperty() eventType!: string;
  @ApiProperty({ minimum: 1 }) eventVersion!: number;
  @ApiProperty({ enum: ActivityCategory }) category!: ActivityCategory;
  @ApiProperty({ enum: ActivitySeverity }) severity!: ActivitySeverity;
  @ApiProperty({ enum: ActivityOrigin }) origin!: ActivityOrigin;
  @ApiProperty({ type: ActivitySubjectDto }) subject!: ActivitySubjectDto;
  @ApiProperty({ type: ActivityRelatedDto }) related!: ActivityRelatedDto;
  @ApiProperty({ type: String, nullable: true }) correlationId!: string | null;
  @ApiProperty({ type: 'object', additionalProperties: true }) metadata!: Record<string, unknown>;
  @ApiProperty({ format: 'date-time' }) occurredAt!: Date;
}

export class ActivityPageMetaDto {
  @ApiProperty() limit!: number;
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
  @ApiProperty({ minimum: 1 }) retentionDays!: number;
}

export class ActivityPageDto {
  @ApiProperty({ type: [ActivityEventDto] }) data!: ActivityEventDto[];
  @ApiProperty({ type: ActivityPageMetaDto }) meta!: ActivityPageMetaDto;
}
