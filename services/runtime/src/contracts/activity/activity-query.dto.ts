import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayNotEmpty, IsArray, IsEnum, IsISO8601, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { ActivityCategory, ActivitySeverity } from './activity.dto';

const commaSeparatedValues = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  return value.split(',').map(item => item.trim()).filter(Boolean);
};

export class ActivityQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  sessionId!: string;

  @ApiPropertyOptional({ maxLength: 200, description: 'Literal search on event ID, subject label, subject ID, correlation ID, or event type.' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @MaxLength(200)
  query?: string;

  @ApiPropertyOptional({ enum: ActivityCategory, isArray: true })
  @IsOptional()
  @Transform(commaSeparatedValues)
  @IsArray()
  @ArrayNotEmpty()
  @IsEnum(ActivityCategory, { each: true })
  category?: ActivityCategory[];

  @ApiPropertyOptional({ enum: ActivitySeverity, isArray: true })
  @IsOptional()
  @Transform(commaSeparatedValues)
  @IsArray()
  @ArrayNotEmpty()
  @IsEnum(ActivitySeverity, { each: true })
  severity?: ActivitySeverity[];

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;

  @ApiPropertyOptional({ maxLength: 512, description: 'Opaque cursor returned by the previous page.' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 50;
}

export class ActivityIdentityQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  sessionId!: string;
}
