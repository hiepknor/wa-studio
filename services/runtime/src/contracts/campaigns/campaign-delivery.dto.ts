import { ApiProperty } from '@nestjs/swagger';
import { PageMetaDto } from '../common/pagination.dto';

export enum CampaignDeliveryStatus {
  PENDING = 'PENDING',
  MATERIALIZED = 'MATERIALIZED',
  PROCESSING = 'PROCESSING',
  DRY_RUN_COMPLETED = 'DRY_RUN_COMPLETED',
  ACCEPTED = 'ACCEPTED',
  SENT = 'SENT',
  DELIVERED = 'DELIVERED',
  READ = 'READ',
  FAILED = 'FAILED',
  UNKNOWN = 'UNKNOWN',
  BLOCKED_CAPABILITY_CHANGED = 'BLOCKED_CAPABILITY_CHANGED',
  CANCELLED = 'CANCELLED',
}

export class CampaignDeliveryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  runId!: string;

  @ApiProperty()
  groupId!: string;

  @ApiProperty()
  groupName!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  messageJobId!: string | null;

  @ApiProperty({ enum: CampaignDeliveryStatus })
  status!: CampaignDeliveryStatus;

  @ApiProperty({ type: String, nullable: true })
  failureReason!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}

export class CampaignDeliveryListDto {
  @ApiProperty({ type: [CampaignDeliveryDto] })
  data!: CampaignDeliveryDto[];

  @ApiProperty({ type: PageMetaDto })
  meta!: PageMetaDto;
}
