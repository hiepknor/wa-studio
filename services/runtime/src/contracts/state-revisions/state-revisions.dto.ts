import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

export class StateRevisionsQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Gateway session owning scoped revisions. Omit to observe session discovery only.',
  })
  @IsOptional()
  @IsUUID()
  sessionId?: string;
}

export class StateRevisionsDto {
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) sessionId!: string | null;
  @ApiProperty({ minimum: 0 }) sessions!: number;
  @ApiProperty({ minimum: 0 }) groups!: number;
  @ApiProperty({ minimum: 0 }) groupLists!: number;
  @ApiProperty({ minimum: 0 }) campaigns!: number;
  @ApiProperty({ minimum: 0 }) runs!: number;
  @ApiProperty({ minimum: 0 }) deliveries!: number;
  @ApiProperty({ minimum: 0 }) activity!: number;
}
