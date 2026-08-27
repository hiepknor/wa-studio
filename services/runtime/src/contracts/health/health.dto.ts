import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OPENWA_RELEASE_TAG } from '../release/openwa-release.generated';

export class HealthLiveDto {
  @ApiProperty({ enum: ['ok'] })
  status!: 'ok';

  @ApiProperty({ enum: ['wa-runtime'] })
  service!: 'wa-runtime';

  @ApiProperty({ example: '0.1.0' })
  version!: string;
}

export class HealthQueueDependencyDto {
  @ApiProperty({ enum: ['redis', 'postgres'] })
  backend!: 'redis' | 'postgres';

  @ApiProperty({ enum: [true] })
  ready!: true;
}

export class HealthDependenciesDto {
  @ApiProperty({ enum: [true] })
  postgres!: true;

  @ApiProperty({ type: HealthQueueDependencyDto })
  queue!: HealthQueueDependencyDto;

  @ApiPropertyOptional({ enum: [true], description: 'Present for the legacy Redis queue backend.' })
  redis?: true;
}

export class RuntimeProcessHealthDto {
  @ApiProperty({ enum: ['healthy', 'degraded'] })
  worker!: 'healthy' | 'degraded';

  @ApiProperty({ enum: ['healthy', 'degraded'] })
  scheduler!: 'healthy' | 'degraded';
}

export class HealthReadyDto {
  @ApiProperty({ enum: ['ready'] })
  status!: 'ready';

  @ApiProperty({ type: HealthDependenciesDto })
  dependencies!: HealthDependenciesDto;

  @ApiProperty({ type: RuntimeProcessHealthDto })
  processes!: RuntimeProcessHealthDto;

  @ApiProperty()
  liveSendsEnabled!: boolean;

  @ApiProperty({ example: OPENWA_RELEASE_TAG })
  openwaRelease!: string;

  @ApiProperty({ minimum: 0 })
  allowedSessionCount!: number;
}

export class HealthNotReadyDto {
  @ApiProperty({ enum: ['not_ready'] })
  status!: 'not_ready';

  @ApiProperty({ enum: ['Runtime dependency unavailable'] })
  reason!: 'Runtime dependency unavailable';
}

export class HealthOperationalDto {
  @ApiProperty({ enum: ['operational', 'degraded'] })
  status!: 'operational' | 'degraded';

  @ApiProperty({ enum: ['wa-runtime'] })
  service!: 'wa-runtime';

  @ApiProperty({ example: '0.1.0' })
  version!: string;

  @ApiProperty({ example: 'desktop-generation-1' })
  instanceId!: string;

  @ApiProperty({ type: HealthDependenciesDto, nullable: true })
  dependencies!: HealthDependenciesDto | null;

  @ApiProperty({ type: RuntimeProcessHealthDto })
  processes!: RuntimeProcessHealthDto;

  @ApiPropertyOptional({
    enum: ['dependency_unavailable', 'background_process_degraded'],
  })
  reason?: 'dependency_unavailable' | 'background_process_degraded';
}
