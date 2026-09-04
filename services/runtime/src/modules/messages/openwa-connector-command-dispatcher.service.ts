import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { runtimeConfig, type RuntimeConfig } from '../../core/config/runtime-config';
import { RUNTIME_CONFIG } from '../../core/config/runtime-config.module';
import { RuntimeDispatchReadinessService } from '../../core/dispatch-readiness/runtime-dispatch-readiness.service';
import {
  OpenWAConnectorIngressClient,
  OpenWAConnectorIngressError,
} from '../../integrations/openwa/openwa-connector-ingress.client';
import {
  OpenWAConnectorCommandRepository,
  type ClaimedOpenWAConnectorCommand,
} from './openwa-connector-command.repository';

@Injectable()
export class OpenWAConnectorCommandDispatcherService {
  private readonly logger = new Logger(OpenWAConnectorCommandDispatcherService.name);

  constructor(
    private readonly commands: OpenWAConnectorCommandRepository,
    private readonly ingress: OpenWAConnectorIngressClient,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig(),
    @Optional() private readonly dispatchReadiness?: RuntimeDispatchReadinessService,
  ) {}

  async run(): Promise<void> {
    if (!this.config.EVENT_INBOX_CONNECTOR_REQUIRED_FOR_LIVE_SENDS) return;
    const expired = await this.commands.settleExpired(this.config.OPENWA_CONNECTOR_DISPATCH_BATCH_SIZE);
    if (expired.failed > 0 || expired.indeterminate > 0) {
      this.logger.warn({ event: 'openwa_connector.commands.expired', ...expired });
    }
    const evidenceTimedOut = await this.commands.settleEvidenceTimeout(
      this.config.OPENWA_CONNECTOR_DISPATCH_BATCH_SIZE,
      this.config.OPENWA_CONNECTOR_EVIDENCE_TIMEOUT_SECONDS * 1_000,
    );
    if (evidenceTimedOut > 0) {
      this.logger.warn({
        event: 'openwa_connector.evidence.timed_out',
        count: evidenceTimedOut,
      });
    }
    if (!(await this.isDispatchReady())) return;
    const commands = await this.commands.claimDue({
      limit: this.config.OPENWA_CONNECTOR_DISPATCH_BATCH_SIZE,
      leaseMs: this.config.OPENWA_CONNECTOR_DISPATCH_LEASE_MS,
      maximumAttempts: this.config.OPENWA_CONNECTOR_MAX_INGRESS_ATTEMPTS,
    });
    await Promise.all(commands.map(command => this.dispatch(command)));
  }

  async dispatchAttempt(attemptId: string): Promise<boolean> {
    if (!this.config.EVENT_INBOX_CONNECTOR_REQUIRED_FOR_LIVE_SENDS) return false;
    if (!(await this.isDispatchReady())) return false;
    const command = (await this.commands.claimDue({
      limit: 1,
      leaseMs: this.config.OPENWA_CONNECTOR_DISPATCH_LEASE_MS,
      maximumAttempts: this.config.OPENWA_CONNECTOR_MAX_INGRESS_ATTEMPTS,
      attemptId,
    }))[0];
    if (!command) return false;
    await this.dispatch(command);
    return true;
  }

  private async dispatch(command: ClaimedOpenWAConnectorCommand): Promise<void> {
    if (!(await this.isDispatchReady())) {
      await this.commands.deferForDispatchReadiness(
        command,
        this.config.EVENT_INBOX_POLL_INTERVAL_MS,
      );
      return;
    }
    const actualDigest = createHash('sha256').update(command.body).digest('hex');
    if (actualDigest !== command.payloadSha256) {
      await this.commands.settleDefinitive(command, 'Connector command payload digest is corrupt');
      this.logger.error({
        event: 'openwa_connector.command.corrupt',
        attemptId: command.attemptId,
        commandId: command.commandId,
      });
      return;
    }
    try {
      const accepted = await this.ingress.submit({ commandId: command.commandId, body: command.body });
      const recorded = await this.commands.markAccepted(command);
      if (recorded) {
        this.logger.log({
          event: 'openwa_connector.command.ingress_accepted',
          attemptId: command.attemptId,
          commandId: command.commandId,
          duplicate: accepted.duplicate,
          deliveryAttempt: command.deliveryAttempt,
        });
      }
    } catch (error) {
      if (!(error instanceof OpenWAConnectorIngressError)) {
        await this.retryOrSettle(command, new OpenWAConnectorIngressError(
          'AMBIGUOUS_RETRYABLE',
          null,
          null,
          error instanceof Error ? error.message : String(error),
        ));
        return;
      }
      await this.retryOrSettle(command, error);
    }
  }

  private async isDispatchReady(): Promise<boolean> {
    if (this.dispatchReadiness) return (await this.dispatchReadiness.snapshot()).ready;
    return !this.config.EVENT_INBOX_BASE_URL;
  }

  private async retryOrSettle(
    command: ClaimedOpenWAConnectorCommand,
    error: OpenWAConnectorIngressError,
  ): Promise<void> {
    if (error.kind === 'DEFINITIVE') {
      await this.commands.settleDefinitive(command, error.message);
      return;
    }
    const delayMs = Math.max(
      error.retryAfterMs ?? 0,
      connectorIngressBackoffMs(command.commandId, command.deliveryAttempt),
    );
    const exhausted = command.deliveryAttempt >= this.config.OPENWA_CONNECTOR_MAX_INGRESS_ATTEMPTS
      || Date.now() + delayMs >= command.expiresAt.valueOf();
    if (exhausted) {
      if (error.kind === 'RATE_LIMITED_SAFE') {
        await this.commands.rescheduleSafeRejection(command, error.message, delayMs);
      } else {
        await this.commands.settleIndeterminate(command, error.message);
      }
      return;
    }
    await this.commands.reschedule(command, error.message, error.kind, delayMs);
  }
}

export function connectorIngressBackoffMs(commandId: string, attempt: number): number {
  const exponential = Math.min(30_000, 1_000 * 2 ** Math.max(0, Math.min(attempt - 1, 5)));
  const jitterSeed = createHash('sha256').update(`${commandId}:${attempt}`).digest().readUInt16BE(0);
  return exponential + Math.floor((jitterSeed / 65_535) * Math.min(2_000, exponential / 2));
}
