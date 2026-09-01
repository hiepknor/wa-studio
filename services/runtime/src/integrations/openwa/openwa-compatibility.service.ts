import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { z } from 'zod';
import { runtimeConfig, type RuntimeConfig } from '../../core/config/runtime-config';
import { RUNTIME_CONFIG } from '../../core/config/runtime-config.module';
import { readBoundedResponseJson } from '../../core/http/bounded-response';

const compatibilityHealthSchema = z.object({
  status: z.string().min(1),
  timestamp: z.string().refine(value => Number.isFinite(Date.parse(value)), 'invalid datetime'),
  version: z.string().min(1),
});

const maximumHealthResponseBytes = 64 * 1024;

export type OpenWACompatibilityStatus =
  | 'UNKNOWN'
  | 'COMPATIBLE'
  | 'UNAVAILABLE'
  | 'INCOMPATIBLE';

export type OpenWACompatibilityReason =
  | 'not_checked'
  | 'network_error'
  | 'http_error'
  | 'invalid_response'
  | 'release_mismatch';

export interface OpenWACompatibilitySnapshot {
  status: OpenWACompatibilityStatus;
  expectedRelease: string;
  observedRelease: string | null;
  checkedAt: string | null;
  lastSuccessfulAt: string | null;
  reason: OpenWACompatibilityReason | null;
}

export class OpenWAUnavailableError extends Error {
  constructor(readonly snapshot: OpenWACompatibilitySnapshot) {
    super('OpenWA is unavailable or did not return a valid health response');
    this.name = 'OpenWAUnavailableError';
  }
}

export class OpenWAIncompatibleReleaseError extends Error {
  constructor(readonly snapshot: OpenWACompatibilitySnapshot) {
    super(
      `OpenWA release mismatch: expected ${snapshot.expectedRelease}, received ${snapshot.observedRelease ?? 'unknown'}`,
    );
    this.name = 'OpenWAIncompatibleReleaseError';
  }
}

@Injectable()
export class OpenWACompatibilityService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OpenWACompatibilityService.name);
  private readonly abort = new AbortController();
  private current: OpenWACompatibilitySnapshot;
  private inFlight: Promise<OpenWACompatibilitySnapshot> | undefined;
  private periodicProbe: NodeJS.Timeout | undefined;

  constructor(@Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig()) {
    this.current = {
      status: 'UNKNOWN',
      expectedRelease: config.OPENWA_RELEASE_TAG,
      observedRelease: null,
      checkedAt: null,
      lastSuccessfulAt: null,
      reason: 'not_checked',
    };
  }

  onApplicationBootstrap(): void {
    this.runPeriodicProbe();
    this.periodicProbe = setInterval(
      () => this.runPeriodicProbe(),
      this.config.OPENWA_COMPATIBILITY_PROBE_INTERVAL_MS,
    );
    this.periodicProbe.unref();
  }

  onModuleDestroy(): void {
    if (this.periodicProbe) clearInterval(this.periodicProbe);
    this.periodicProbe = undefined;
    this.abort.abort();
  }

  snapshot(): OpenWACompatibilitySnapshot {
    return { ...this.current };
  }

  async probe(options: { force?: boolean } = {}): Promise<OpenWACompatibilitySnapshot> {
    if (!options.force && this.isFresh(this.current)) return this.snapshot();
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.performProbe().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  async requireCompatible(options: { force?: boolean } = {}): Promise<void> {
    const snapshot = await this.probe(options);
    if (snapshot.status === 'COMPATIBLE') return;
    if (snapshot.status === 'INCOMPATIBLE') {
      throw new OpenWAIncompatibleReleaseError(snapshot);
    }
    throw new OpenWAUnavailableError(snapshot);
  }

  private isFresh(snapshot: OpenWACompatibilitySnapshot): boolean {
    if (!snapshot.checkedAt) return false;
    const checkedAt = Date.parse(snapshot.checkedAt);
    const age = Date.now() - checkedAt;
    return Number.isFinite(checkedAt)
      && age >= 0
      && age < this.config.OPENWA_COMPATIBILITY_FRESHNESS_MS;
  }

  private async performProbe(): Promise<OpenWACompatibilitySnapshot> {
    const previous = this.snapshot();
    const checkedAt = new Date().toISOString();
    try {
      const response = await fetch(new URL('/api/health', this.config.OPENWA_BASE_URL), {
        headers: {
          accept: 'application/json',
          'x-api-key': this.config.OPENWA_API_KEY,
        },
        redirect: 'error',
        signal: AbortSignal.any([
          this.abort.signal,
          AbortSignal.timeout(this.config.OPENWA_COMPATIBILITY_PROBE_TIMEOUT_MS),
        ]),
      });
      if (!response.ok) {
        response.body?.cancel().catch(() => undefined);
        return this.update({
          status: 'UNAVAILABLE',
          observedRelease: null,
          checkedAt,
          reason: 'http_error',
        }, previous);
      }
      let body: unknown;
      try {
        body = await readBoundedResponseJson(response, maximumHealthResponseBytes);
      } catch (error) {
        if (this.abort.signal.aborted) throw error;
        return this.update({
          status: 'UNAVAILABLE',
          observedRelease: null,
          checkedAt,
          reason: 'invalid_response',
        }, previous);
      }
      const parsed = compatibilityHealthSchema.safeParse(body);
      if (!parsed.success) {
        return this.update({
          status: 'UNAVAILABLE',
          observedRelease: null,
          checkedAt,
          reason: 'invalid_response',
        }, previous);
      }
      const compatible = parsed.data.version === this.config.OPENWA_RELEASE_TAG;
      return this.update({
        status: compatible ? 'COMPATIBLE' : 'INCOMPATIBLE',
        observedRelease: parsed.data.version,
        checkedAt,
        reason: compatible ? null : 'release_mismatch',
        ...(compatible ? { lastSuccessfulAt: checkedAt } : {}),
      }, previous);
    } catch (error) {
      if (this.abort.signal.aborted) throw error;
      return this.update({
        status: 'UNAVAILABLE',
        observedRelease: null,
        checkedAt,
        reason: 'network_error',
      }, previous);
    }
  }

  private update(
    next: Pick<OpenWACompatibilitySnapshot, 'status' | 'observedRelease' | 'checkedAt' | 'reason'>
      & Partial<Pick<OpenWACompatibilitySnapshot, 'lastSuccessfulAt'>>,
    previous: OpenWACompatibilitySnapshot,
  ): OpenWACompatibilitySnapshot {
    this.current = {
      ...this.current,
      ...next,
      expectedRelease: this.config.OPENWA_RELEASE_TAG,
    };
    if (previous.status !== this.current.status
      || previous.observedRelease !== this.current.observedRelease
      || previous.reason !== this.current.reason) {
      const payload = {
        event: 'openwa.compatibility.changed',
        previousStatus: previous.status,
        status: this.current.status,
        expectedRelease: this.current.expectedRelease,
        observedRelease: this.current.observedRelease,
        reason: this.current.reason,
      };
      if (this.current.status === 'COMPATIBLE') this.logger.log(payload);
      else this.logger.warn(payload);
    }
    return this.snapshot();
  }

  private runPeriodicProbe(): void {
    void this.probe({ force: true }).catch(error => {
      if (!this.abort.signal.aborted) {
        this.logger.error({ event: 'openwa.compatibility.probe_failed', error });
      }
    });
  }
}
