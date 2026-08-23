import { Inject, Injectable, Logger } from '@nestjs/common';
import { runtimeConfig, type RuntimeConfig } from '../../core/config/runtime-config';
import { RUNTIME_CONFIG } from '../../core/config/runtime-config.module';
import { withCorrelationContext } from '../../core/observability/correlation-context';
import { terminationSignal } from '../../core/process/termination-signal';
import { RUNTIME_HEARTBEAT_INTERVAL_MS } from '../../core/queue/runtime-heartbeat';
import { QueueService } from '../../core/queue/queue.service';
import { CampaignDispatchTick } from './campaign-dispatch.tick';
import { CampaignLifecycleAuditTick } from './campaign-lifecycle-audit.tick';
import { DataRetentionTick } from './data-retention.tick';
import { GatewayDispatchTick } from './gateway-dispatch.tick';
import { IsolatedSchedulerTick } from './isolated-scheduler-tick';
import { MessageDispatchTick } from './message-dispatch.tick';
import { WebhookDispatchTick } from './webhook-dispatch.tick';
import { GatewayWorkListenerService } from './gateway-work-listener.service';
import { ContactPeriodicSyncTick } from '../contacts/contact-periodic-sync.tick';
import { WebhookRegistrationReconciliationTick } from '../webhooks/webhook-registration-reconciliation.tick';
import { ContactMemberIdentityBackfillTick } from '../contacts/contact-member-identity-backfill.tick';
import { ContactResolutionTick } from '../contacts/contact-resolution.tick';
import { ContactProjectionTick } from '../contacts/contact-projection.tick';
import { SchedulerLeadershipService } from './scheduler-leadership.service';
import { ContactMessageObservationTick } from '../contacts/contact-message-observation.tick';

@Injectable()
export class SchedulerRunnerService {
  private readonly logger = new Logger(SchedulerRunnerService.name);
  private ticks: IsolatedSchedulerTick[] = [];
  private heartbeat: NodeJS.Timeout | undefined;
  private listenerStarted = false;
  private started = false;
  constructor(
    private readonly messages: MessageDispatchTick,
    private readonly webhooks: WebhookDispatchTick,
    private readonly gateway: GatewayDispatchTick,
    private readonly campaigns: CampaignDispatchTick,
    private readonly campaignLifecycleAudit: CampaignLifecycleAuditTick,
    private readonly retention: DataRetentionTick,
    private readonly queues: QueueService,
    private readonly gatewayListener: GatewayWorkListenerService,
    private readonly contacts: ContactPeriodicSyncTick,
    private readonly webhookRegistrations: WebhookRegistrationReconciliationTick,
    private readonly contactMemberIdentityBackfill: ContactMemberIdentityBackfillTick,
    private readonly contactResolution: ContactResolutionTick,
    private readonly contactProjection: ContactProjectionTick,
    private readonly contactMessageObservations: ContactMessageObservationTick,
    private readonly leadership: SchedulerLeadershipService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig(),
  ) {}

  async run(): Promise<void> {
    const termination = terminationSignal();
    try {
      await this.start();
      const leadershipFailure = await Promise.race([
        termination.promise.then(() => null),
        this.waitForFailure(),
      ]);
      if (leadershipFailure) throw leadershipFailure;
    } finally {
      termination.dispose();
      await this.stop();
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.leadership.acquire();
    this.logger.log({ event: 'scheduler.leadership.acquired' });
    const gatewayTick = this.tick(
      'gateway', this.config.GATEWAY_SYNC_POLL_INTERVAL_MS, 60_000, () => this.gateway.run(),
    );
    this.ticks = [
      this.tick('messages', 1_000, 30_000, () => this.messages.run()),
      this.tick('webhooks', 1_000, 30_000, () => this.webhooks.run()),
      gatewayTick,
      this.tick('campaigns', 1_000, 30_000, () => this.campaigns.run()),
      this.tick('campaign-lifecycle-audit', 60_000, 30_000, () => this.campaignLifecycleAudit.run()),
      this.tick(
        'retention',
        this.config.RUNTIME_RETENTION_INTERVAL_MS,
        5 * 60_000,
        () => this.retention.run(),
      ),
      this.tick('contacts', 300_000, 15 * 60_000, () => this.contacts.run()),
      this.tick(
        'contact-member-identity-backfill',
        30_000,
        2 * 60_000,
        () => this.contactMemberIdentityBackfill.run(),
      ),
      this.tick(
        'contact-resolution',
        60_000,
        5 * 60_000,
        () => this.contactResolution.run(),
      ),
      this.tick(
        'contact-projection',
        5_000,
        60_000,
        () => this.contactProjection.run(),
      ),
      this.tick(
        'contact-message-observations',
        5_000,
        60_000,
        () => this.contactMessageObservations.run(),
      ),
      this.tick(
        'webhook-registration',
        this.config.OPENWA_WEBHOOK_RECONCILIATION_INTERVAL_MS,
        2 * 60_000,
        () => this.webhookRegistrations.run(),
      ),
    ];
    this.started = true;
    try {
      this.heartbeat = setInterval(() => void this.publishHeartbeat(), RUNTIME_HEARTBEAT_INTERVAL_MS);
      this.heartbeat.unref();
      await this.publishHeartbeat();
      for (const tick of this.ticks) tick.start();
      await this.gatewayListener.start(() => gatewayTick.execute());
      this.listenerStarted = true;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  waitForFailure(): Promise<Error> {
    if (!this.started) throw new Error('Scheduler is not running');
    return this.leadership.waitForLoss();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    const ticks = this.ticks;
    this.ticks = [];
    const listenerStarted = this.listenerStarted;
    this.listenerStarted = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    const cleanup = await Promise.allSettled([
      ...(listenerStarted ? [this.gatewayListener.stop()] : []),
      ...ticks.map(tick => tick.stop()),
    ]);
    for (const result of cleanup) {
      if (result.status === 'rejected') {
        this.logger.error({ event: 'scheduler.shutdown.failed', error: result.reason });
      }
    }
    await this.leadership.release();
    this.logger.log({ event: 'scheduler.leadership.released' });
  }

  private tick(
    name: string,
    intervalMs: number,
    timeoutMs: number,
    operation: () => Promise<void>,
  ): IsolatedSchedulerTick {
    return new IsolatedSchedulerTick({
      name,
      intervalMs,
      timeoutMs,
      maxBackoffMs: Math.max(60_000, intervalMs * 8),
      operation: () => withCorrelationContext({ tick: name }, operation),
      report: state => this.queues.publishSchedulerTickState(state),
      logger: this.logger,
    });
  }

  private async publishHeartbeat(): Promise<void> {
    try {
      await this.queues.publishHeartbeat('scheduler');
    } catch (error) {
      this.logger.error({ event: 'runtime.heartbeat.failed', process: 'scheduler', error });
    }
  }
}
