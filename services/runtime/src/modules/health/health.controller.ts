import { Controller, Get, Inject, Logger, Optional, Res, ServiceUnavailableException } from '@nestjs/common';
import { ApiOkResponse, ApiSecurity, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../../core/auth/public.decorator';
import {
  HealthLiveDto,
  HealthNotReadyDto,
  HealthOperationalDto,
  HealthReadyDto,
} from '../../contracts/health/health.dto';
import { runtimeConfig, type RuntimeConfig } from '../../core/config/runtime-config';
import { RUNTIME_CONFIG } from '../../core/config/runtime-config.module';
import { DatabaseService } from '../../core/database/database.service';
import { QueueService } from '../../core/queue/queue.service';
import type { QueueReadiness, RuntimeProcessHealth } from '../../core/queue/queue-transport';
import { RUNTIME_SERVICE, RUNTIME_VERSION } from '../../core/release/runtime-release';
import {
  OpenWACompatibilityService,
  type OpenWACompatibilitySnapshot,
} from '../../integrations/openwa/openwa-compatibility.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly queues: QueueService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig(),
    @Optional() private readonly openwaCompatibility?: OpenWACompatibilityService,
  ) {}

  @Public()
  @Get('live')
  @ApiOkResponse({ type: HealthLiveDto })
  live(): HealthLiveDto {
    return { status: 'ok', service: RUNTIME_SERVICE, version: RUNTIME_VERSION };
  }

  @Get('ready')
  @ApiSecurity('runtime-key')
  @ApiOkResponse({ type: HealthReadyDto })
  @ApiServiceUnavailableResponse({ type: HealthNotReadyDto })
  async ready(): Promise<HealthReadyDto> {
    let processes: RuntimeProcessHealth;
    let queue: QueueReadiness;
    try {
      await this.database.query('SELECT 1');
      queue = await this.queues.readiness();
      processes = await this.queues.runtimeProcessHealth();
    } catch (error) {
      this.logger.error({ event: 'runtime.readiness.failed', error });
      throw new ServiceUnavailableException({
        status: 'not_ready',
        reason: 'Runtime dependency unavailable',
      });
    }
    return {
      status: 'ready',
      dependencies: {
        postgres: true,
        queue,
        ...(queue.backend === 'redis' ? { redis: true as const } : {}),
      },
      processes,
      liveSendsEnabled: this.config.ALLOW_LIVE_SENDS,
      openwaRelease: this.config.OPENWA_RELEASE_TAG,
      allowedSessionCount: this.config.OPENWA_ALLOWED_SESSION_IDS.length,
    };
  }

  @Get('operational')
  @ApiSecurity('runtime-key')
  @ApiOkResponse({ type: HealthOperationalDto })
  @ApiServiceUnavailableResponse({ type: HealthOperationalDto })
  async operational(@Res({ passthrough: true }) response: Response): Promise<HealthOperationalDto> {
    const openwa = this.openwaCompatibility?.snapshot() ?? this.unknownOpenWASnapshot();
    const base = {
      service: RUNTIME_SERVICE,
      version: RUNTIME_VERSION,
      instanceId: this.config.RUNTIME_INSTANCE_ID,
      components: { openwa },
    } as const;
    let dependencies: HealthOperationalDto['dependencies'];
    let processes: RuntimeProcessHealth;
    try {
      await this.database.query('SELECT 1');
      const queue = await this.queues.readiness();
      dependencies = {
        postgres: true,
        queue,
        ...(queue.backend === 'redis' ? { redis: true as const } : {}),
      };
      processes = await this.queues.runtimeProcessHealth();
    } catch (error) {
      this.logger.error({ event: 'runtime.operational.failed', error });
      response.status(503);
      return {
        ...base,
        status: 'degraded',
        dependencies: null,
        processes: { worker: 'degraded', scheduler: 'degraded' },
        reason: 'dependency_unavailable',
      };
    }
    if (processes.worker !== 'healthy' || processes.scheduler !== 'healthy') {
      response.status(503);
      return {
        ...base,
        status: 'degraded',
        dependencies,
        processes,
        reason: 'background_process_degraded',
      };
    }
    if (openwa.status !== 'COMPATIBLE') {
      return {
        ...base,
        status: 'degraded',
        dependencies,
        processes,
        reason: openwa.status === 'INCOMPATIBLE'
          ? 'upstream_incompatible'
          : openwa.status === 'UNAVAILABLE'
            ? 'upstream_unavailable'
            : 'upstream_status_unknown',
      };
    }
    return { ...base, status: 'operational', dependencies, processes };
  }

  private unknownOpenWASnapshot(): OpenWACompatibilitySnapshot {
    return {
      status: 'UNKNOWN',
      expectedRelease: this.config.OPENWA_RELEASE_TAG,
      observedRelease: null,
      checkedAt: null,
      lastSuccessfulAt: null,
      reason: 'not_checked',
    };
  }
}
