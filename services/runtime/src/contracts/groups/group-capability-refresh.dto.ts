import { ApiProperty } from '@nestjs/swagger';

export type GroupCapabilityRefreshStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'RETRYING'
  | 'COMPLETED'
  | 'FAILED';

export type GroupCapabilityRefreshSource = 'MANUAL' | 'SYSTEM';

export class GroupCapabilityRefreshDto {
  @ApiProperty({ format: 'uuid' })
  sessionId!: string;

  @ApiProperty({ example: '120363000000000000@g.us' })
  groupId!: string;

  @ApiProperty({ minimum: 1 })
  requestRevision!: number;

  @ApiProperty({ enum: ['PENDING', 'RUNNING', 'RETRYING', 'COMPLETED', 'FAILED'] })
  status!: GroupCapabilityRefreshStatus;

  @ApiProperty({ enum: ['MANUAL', 'SYSTEM'] })
  source!: GroupCapabilityRefreshSource;

  @ApiProperty({ minimum: 0 })
  attemptCount!: number;

  @ApiProperty({ type: String, format: 'date-time' })
  requestedAt!: Date;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  startedAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  nextAttemptAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  completedAt!: Date | null;

  @ApiProperty({ type: String, nullable: true })
  errorCode!: string | null;
}
