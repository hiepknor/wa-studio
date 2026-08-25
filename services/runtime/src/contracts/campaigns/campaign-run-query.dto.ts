import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayNotEmpty, IsArray, IsEnum, IsISO8601, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../common/pagination.dto';
import { CampaignExecutionMode } from './campaign-preflight.dto';
import { CampaignRunStatus } from './campaign-run.dto';

const commaSeparatedValues = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  return value.split(',').map(item => item.trim()).filter(Boolean);
};

export class CampaignRunQueryDto extends PaginationQueryDto {
  @ApiProperty({ format: 'uuid', description: 'Allowlisted Gateway session that owns the runs' })
  @IsUUID()
  sessionId!: string;

  @ApiPropertyOptional({
    maxLength: 200,
    description: 'Trimmed case-insensitive literal substring search on campaign snapshot name, or exact campaign/run UUID.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @MaxLength(200)
  query?: string;

  @ApiPropertyOptional({ enum: CampaignRunStatus, isArray: true })
  @IsOptional()
  @Transform(commaSeparatedValues)
  @IsArray()
  @ArrayNotEmpty()
  @IsEnum(CampaignRunStatus, { each: true })
  status?: CampaignRunStatus[];

  @ApiPropertyOptional({ enum: CampaignExecutionMode, isArray: true })
  @IsOptional()
  @Transform(commaSeparatedValues)
  @IsArray()
  @ArrayNotEmpty()
  @IsEnum(CampaignExecutionMode, { each: true })
  executionMode?: CampaignExecutionMode[];

  @ApiPropertyOptional({ format: 'date-time', description: 'Inclusive lower bound on run creation time.' })
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @ApiPropertyOptional({ format: 'date-time', description: 'Exclusive upper bound on run creation time.' })
  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;
}
