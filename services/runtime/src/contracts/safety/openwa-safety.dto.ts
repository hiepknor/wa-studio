import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export enum OpenWASafetyProfileDto {
  CANARY = 'CANARY',
  STANDARD = 'STANDARD',
}

export enum OpenWASafetyControlActionDto {
  BLOCK = 'BLOCK',
  RESUME = 'RESUME',
}

export enum OpenWAOutboundControlActionDto {
  PAUSE = 'PAUSE',
  RESUME = 'RESUME',
}

export class OpenWASafetyControlDto {
  @ApiProperty({ enum: OpenWASafetyControlActionDto })
  @IsEnum(OpenWASafetyControlActionDto)
  action!: OpenWASafetyControlActionDto;

  @ApiPropertyOptional({ minLength: 1, maxLength: 200 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  reason?: string;
}

export class OpenWAOutboundControlDto {
  @ApiProperty({ enum: OpenWAOutboundControlActionDto })
  @IsEnum(OpenWAOutboundControlActionDto)
  action!: OpenWAOutboundControlActionDto;

  @ApiPropertyOptional({ minLength: 1, maxLength: 200 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  reason?: string;
}

export class OpenWASafetyProfileChangeDto {
  @ApiProperty({ enum: OpenWASafetyProfileDto })
  @IsEnum(OpenWASafetyProfileDto)
  profile!: OpenWASafetyProfileDto;
}

export class OpenWASafetyScopeDto {
  @ApiProperty({ enum: ['WORKSPACE', 'UPSTREAM', 'SESSION'] })
  scopeType!: string;

  @ApiProperty({ enum: ['WORKSPACE', 'UPSTREAM', 'SESSION'] })
  effectiveScopeType!: string;

  @ApiProperty({ enum: ['CLOSED', 'OPEN', 'HALF_OPEN', 'MANUAL_BLOCKED'] })
  circuitState!: string;

  @ApiProperty({ enum: ['NORMAL', 'THROTTLED'] })
  rateMode!: string;

  @ApiProperty({ enum: ['READY', 'THROTTLED', 'COOLDOWN', 'RECOVERY', 'BLOCKED'] })
  status!: string;

  @ApiProperty({ type: String, nullable: true })
  reason!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  cooldownUntil!: Date | null;

  @ApiProperty({ enum: OpenWASafetyProfileDto })
  profile!: OpenWASafetyProfileDto;

  @ApiProperty({ enum: ['RUNNING', 'PAUSED'] })
  outboundState!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  outboundPausedAt!: Date | null;

  @ApiProperty({ type: String, nullable: true })
  outboundPauseReason!: string | null;

  @ApiProperty() policyVersion!: number;
  @ApiProperty() revision!: number;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastSuccessAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastFailureAt!: Date | null;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}

export class OpenWASafetyQuiescenceDto {
  @ApiProperty() drained!: boolean;
  @ApiProperty() processingMessageJobs!: number;
  @ApiProperty() unsettledConnectorCommands!: number;
  @ApiProperty() activeSafetyLeases!: number;

  @ApiProperty({ format: 'date-time' })
  checkedAt!: Date;
}
