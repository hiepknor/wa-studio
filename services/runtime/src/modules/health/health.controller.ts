import { Controller, Get, Inject, Logger, Optional, Res, ServiceUnavailableException } from '@nestjs/common';
import {
  ApiExcludeEndpoint,
  ApiOkResponse,
  ApiSecurity,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../../core/auth/public.decorator';
import {
  OpenWAConnectorComponentHealthDto,
  HealthLiveDto,
  HealthNotReadyDto,
  HealthOperationalDto,
  HealthReadyDto,
  RuntimeDispatchReadinessDto,
} from '../../contracts/health/health.dto';
import { runtimeConfig, type RuntimeConfig } from '../../core/config/runtime-config';
import { RUNTIME_CONFIG } from '../../core/config/runtime-config.module';
import { DatabaseService } from '../../core/database/database.service';
import { QueueService } from '../../core/queue/queue.service';
import {
  RuntimeDispatchReadinessService,
  type RuntimeDispatchReadinessSnapshot,
} from '../../core/dispatch-readiness/runtime-dispatch-readiness.service';
import type { QueueReadiness, RuntimeProcessHealth } from '../../core/queue/queue-transport';
import { RUNTIME_SERVICE, RUNTIME_VERSION } from '../../core/release/runtime-release';
import {
  OpenWACompatibilityService,
  type OpenWACompatibilitySnapshot,
} from '../../integrations/openwa/openwa-compatibility.service';
import {
  RuntimeReleaseEvidenceService,
  type RuntimeReleaseEvidenceSnapshot,
} from './runtime-release-evidence.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly queues: QueueService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig(),
    @Optional() private readonly openwaCompatibility?: OpenWACompatibilityService,
    @Optional() private readonly dispatchReadiness?: RuntimeDispatchReadinessService,
    @Optional() private readonly releaseEvidence?: RuntimeReleaseEvidenceService,
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
    let dispatch: RuntimeDispatchReadinessDto;
    try {
      await this.database.query('SELECT 1');
      queue = await this.queues.readiness();
      processes = await this.queues.runtimeProcessHealth();
      dispatch = this.dispatchSnapshotDto(
        await this.dispatchReadiness?.snapshot() ?? this.unknownDispatchSnapshot(),
      );
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
      dispatch,
    };
  }

  @Get('operational')
  @ApiSecurity('runtime-key')
  @ApiOkResponse({ type: HealthOperationalDto })
  @ApiServiceUnavailableResponse({ type: HealthOperationalDto })
  async operational(@Res({ passthrough: true }) response: Response): Promise<HealthOperationalDto> {
    const openwa = this.openwaCompatibility?.snapshot() ?? this.unknownOpenWASnapshot();
    let connector = this.unknownConnectorSnapshot();
    let dispatch = this.dispatchSnapshotDto(this.unknownDispatchSnapshot());
    const base = () => ({
      service: RUNTIME_SERVICE,
      version: RUNTIME_VERSION,
      instanceId: this.config.RUNTIME_INSTANCE_ID,
      components: { openwa, connector, dispatch },
    } as const);
    let dependencies: HealthOperationalDto['dependencies'];
    let processes: RuntimeProcessHealth;
    try {
      await this.database.query('SELECT 1');
      connector = await this.connectorSnapshot();
      dispatch = this.dispatchSnapshotDto(
        await this.dispatchReadiness?.snapshot() ?? this.unknownDispatchSnapshot(),
      );
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
        ...base(),
        status: 'degraded',
        dependencies: null,
        processes: { worker: 'degraded', scheduler: 'degraded' },
        reason: 'dependency_unavailable',
      };
    }
    if (processes.worker !== 'healthy' || processes.scheduler !== 'healthy') {
      response.status(503);
      return {
        ...base(),
        status: 'degraded',
        dependencies,
        processes,
        reason: 'background_process_degraded',
      };
    }
    if (openwa.status !== 'COMPATIBLE') {
      return {
        ...base(),
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
    if (connector.requiredForLiveSends && connector.status !== 'HEALTHY') {
      return {
        ...base(),
        status: 'degraded',
        dependencies,
        processes,
        reason: 'connector_unhealthy',
      };
    }
    if (!dispatch.ready) {
      response.status(503);
      return {
        ...base(),
        status: 'degraded',
        dependencies,
        processes,
        reason: 'dispatch_not_ready',
      };
    }
    return { ...base(), status: 'operational', dependencies, processes };
  }

  @Get('release-evidence')
  @ApiExcludeEndpoint()
  async productionReleaseEvidence(): Promise<RuntimeReleaseEvidenceSnapshot> {
    try {
      if (!this.releaseEvidence) throw new Error('Runtime release evidence service is unavailable');
      return await this.releaseEvidence.snapshot();
    } catch (error) {
      this.logger.error({ event: 'runtime.release_evidence.failed', error });
      throw new ServiceUnavailableException('Runtime release evidence is unavailable');
    }
  }

  private async connectorSnapshot(): Promise<OpenWAConnectorComponentHealthDto> {
    if (!this.config.EVENT_INBOX_BASE_URL) return this.unknownConnectorSnapshot();
    const result = await this.database.query<{
      session_id: string;
      health_state: OpenWAConnectorComponentHealthDto['sessions'][number]['state'] | null;
      health_reason: string | null;
      plugin_version: string | null;
      heartbeat_observed_at: Date | null;
      health_lease_expires_at: Date | null;
      pending_count: string | null;
      storage_utilization: number | null;
    }>(
      `SELECT allowed.session_id::text, connector.health_state, connector.health_reason,
         connector.plugin_version, connector.heartbeat_observed_at,
         connector.health_lease_expires_at, connector.pending_count::text,
         connector.storage_utilization
       FROM unnest($1::text[]) AS allowed(session_id)
       LEFT JOIN openwa_connector_sessions connector ON connector.session_id = allowed.session_id
       ORDER BY allowed.session_id`,
      [this.config.OPENWA_ALLOWED_SESSION_IDS],
    );
    const now = Date.now();
    const sessions = result.rows.map(row => ({
      sessionId: row.session_id,
      state: row.health_state === 'HEALTHY'
        && (!row.health_lease_expires_at || row.health_lease_expires_at.valueOf() <= now)
        ? 'STALE' as const
        : row.health_state ?? 'NOT_CONFIGURED' as const,
      reason: row.health_state === 'HEALTHY'
        && (!row.health_lease_expires_at || row.health_lease_expires_at.valueOf() <= now)
        ? 'connector_health_lease_expired'
        : row.health_reason,
      pluginVersion: row.plugin_version,
      heartbeatObservedAt: row.heartbeat_observed_at?.toISOString() ?? null,
      leaseExpiresAt: row.health_lease_expires_at?.toISOString() ?? null,
      pendingCount: row.pending_count === null ? null : Number(row.pending_count),
      storageUtilization: row.storage_utilization,
    }));
    const healthySessionCount = sessions.filter(session => session.state === 'HEALTHY').length;
    return {
      status: sessions.length > 0 && healthySessionCount === sessions.length ? 'HEALTHY' : 'DEGRADED',
      requiredForLiveSends: this.config.EVENT_INBOX_CONNECTOR_REQUIRED_FOR_LIVE_SENDS,
      healthySessionCount,
      sessionCount: sessions.length,
      sessions,
    };
  }

  private unknownConnectorSnapshot(): OpenWAConnectorComponentHealthDto {
    return {
      status: this.config.EVENT_INBOX_BASE_URL ? 'DEGRADED' : 'DISABLED',
      requiredForLiveSends: this.config.EVENT_INBOX_CONNECTOR_REQUIRED_FOR_LIVE_SENDS,
      healthySessionCount: 0,
      sessionCount: this.config.EVENT_INBOX_BASE_URL
        ? this.config.OPENWA_ALLOWED_SESSION_IDS.length
        : 0,
      sessions: [],
    };
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

  private unknownDispatchSnapshot(): RuntimeDispatchReadinessSnapshot {
    return {
      required: this.dispatchReadiness?.required() ?? Boolean(this.config.EVENT_INBOX_BASE_URL),
      ready: !(this.dispatchReadiness?.required() ?? Boolean(this.config.EVENT_INBOX_BASE_URL)),
      state: (this.dispatchReadiness?.required() ?? Boolean(this.config.EVENT_INBOX_BASE_URL))
        ? 'RECOVERING' : 'DISABLED',
      reason: (this.dispatchReadiness?.required() ?? Boolean(this.config.EVENT_INBOX_BASE_URL))
        ? 'event_inbox_recovery_not_checked' : null,
      recoveryWatermark: null,
      recoveryStartedAt: null,
      readyAt: null,
      heartbeatAt: null,
    };
  }

  private dispatchSnapshotDto(
    snapshot: RuntimeDispatchReadinessSnapshot,
  ): RuntimeDispatchReadinessDto {
    return {
      ...snapshot,
      recoveryStartedAt: snapshot.recoveryStartedAt?.toISOString() ?? null,
      readyAt: snapshot.readyAt?.toISOString() ?? null,
      heartbeatAt: snapshot.heartbeatAt?.toISOString() ?? null,
    };
  }
}
