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

export class OpenWAComponentHealthDto {
  @ApiProperty({ enum: ['UNKNOWN', 'COMPATIBLE', 'UNAVAILABLE', 'INCOMPATIBLE'] })
  status!: 'UNKNOWN' | 'COMPATIBLE' | 'UNAVAILABLE' | 'INCOMPATIBLE';

  @ApiProperty({ example: OPENWA_RELEASE_TAG })
  expectedRelease!: string;

  @ApiProperty({ type: String, nullable: true, example: OPENWA_RELEASE_TAG })
  observedRelease!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  checkedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  lastSuccessfulAt!: string | null;

  @ApiProperty({
    nullable: true,
    enum: ['not_checked', 'network_error', 'http_error', 'invalid_response', 'release_mismatch'],
  })
  reason!: 'not_checked' | 'network_error' | 'http_error' | 'invalid_response' | 'release_mismatch' | null;
}

export class RuntimeComponentHealthDto {
  @ApiProperty({ type: OpenWAComponentHealthDto })
  openwa!: OpenWAComponentHealthDto;
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

  @ApiProperty({ type: RuntimeComponentHealthDto })
  components!: RuntimeComponentHealthDto;

  @ApiPropertyOptional({
    enum: [
      'dependency_unavailable',
      'background_process_degraded',
      'upstream_status_unknown',
      'upstream_unavailable',
      'upstream_incompatible',
    ],
  })
  reason?: 'dependency_unavailable' | 'background_process_degraded'
    | 'upstream_status_unknown' | 'upstream_unavailable' | 'upstream_incompatible';
}
