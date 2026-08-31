import {
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpException,
  HttpCode,
  HttpStatus,
  Ip,
  Inject,
  PayloadTooLargeException,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  eventInboxAckSchema,
  eventInboxClaimSchema,
  eventInboxNackSchema,
  eventInboxPairingRequestSchema,
  openWAWebhookEnvelopeSchema,
} from '../../contracts/event-inbox';
import {
  OPENWA_CONNECTOR_JOURNAL_SCHEMA_VERSION,
  OPENWA_CONNECTOR_PROTOCOL_VERSION,
} from '../../contracts/openwa-connector';
import { OPENWA_RELEASE_TAG } from '../../contracts/release/openwa-release.generated';
import { EVENT_INBOX_CONFIG } from '../../core/event-inbox/event-inbox-config.module';
import { eventInboxConfig, type EventInboxConfig } from '../../core/event-inbox/event-inbox-config';
import { EventInboxTokenService } from '../../core/event-inbox/event-inbox-token.service';
import { RUNTIME_VERSION } from '../../core/release/runtime-release';
import { verifySha256Hmac } from '../../core/security/hmac-signature';
import { EventInboxOpenWAClient } from '../../integrations/openwa/event-inbox-openwa.client';
import {
  EventInboxDeviceRepository,
  type EventInboxDeviceAuthorization,
} from './event-inbox-device.repository';
import { decodeEventInboxReceipt } from './event-inbox-receipt';
import { EventInboxPairRateLimitService } from './event-inbox-rate-limit.service';
import { EventInboxRepository } from './event-inbox.repository';

@Controller('webhooks/openwa')
export class EventInboxIngressController {
  private readonly allowedSessions: Set<string>;

  constructor(
    private readonly repository: EventInboxRepository,
    private readonly tokens: EventInboxTokenService,
    @Inject(EVENT_INBOX_CONFIG) private readonly config: EventInboxConfig = eventInboxConfig(),
  ) {
    this.allowedSessions = new Set(config.EVENT_INBOX_ALLOWED_SESSION_IDS);
  }

  @Post()
  async receive(
    @Req() request: RawBodyRequest<Request>,
    @Headers('x-openwa-signature') signature: string | undefined,
  ) {
    if (!request.rawBody) throw new UnauthorizedException('Missing raw webhook body');
    if (request.rawBody.length > this.config.EVENT_INBOX_MAX_PAYLOAD_BYTES) {
      throw new PayloadTooLargeException('OpenWA webhook exceeds Event Inbox payload limit');
    }
    if (!verifySha256Hmac(request.rawBody, signature, this.tokens.webhookSecret())) {
      throw new UnauthorizedException('Invalid OpenWA webhook signature');
    }
    const parsed = openWAWebhookEnvelopeSchema.safeParse(request.body);
    if (!parsed.success || !this.allowedSessions.has(parsed.data.sessionId)) {
      throw new UnprocessableEntityException('Invalid or disallowed OpenWA webhook envelope');
    }
    const result = await this.repository.insert(request.rawBody, signature!, parsed.data);
    if (result === 'conflict') {
      throw new ConflictException('OpenWA webhook idempotency key conflicts with a different payload');
    }
    if (result === 'capacity') {
      throw new ServiceUnavailableException('Event Inbox storage capacity is exhausted');
    }
    return { accepted: true, duplicate: result === 'duplicate' };
  }
}

@Controller('event-inbox')
export class EventInboxController {
  constructor(
    private readonly repository: EventInboxRepository,
    private readonly tokens: EventInboxTokenService,
    private readonly devices: EventInboxDeviceRepository,
    private readonly openwa: EventInboxOpenWAClient,
    private readonly pairingRateLimit: EventInboxPairRateLimitService,
    @Inject(EVENT_INBOX_CONFIG) private readonly config: EventInboxConfig = eventInboxConfig(),
  ) {}

  @Post('pair')
  @HttpCode(200)
  async pair(
    @Body() body: unknown,
    @Ip() sourceIp: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const rateLimit = await this.pairingRateLimit.consume(sourceIp);
    if (!rateLimit.allowed) {
      response.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
      throw new HttpException(
        'Event Inbox pairing rate limit exceeded',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const parsed = eventInboxPairingRequestSchema.safeParse(body);
    if (!parsed.success) throw new UnprocessableEntityException('Invalid Event Inbox pairing request');
    let sessionIds: string[];
    try {
      sessionIds = await this.openwa.validateCredentials(
        parsed.data.openwaBaseUrl,
        parsed.data.openwaApiKey,
      );
    } catch {
      throw new UnauthorizedException('OpenWA credentials could not be verified');
    }
    const device = await this.devices.pair(parsed.data.deviceId, sessionIds);
    return {
      protocolVersion: 2 as const,
      eventInboxBaseUrl: this.config.EVENT_INBOX_PUBLIC_BASE_URL,
      callbackUrl: new URL(
        '/api/v1/webhooks/openwa',
        this.config.EVENT_INBOX_PUBLIC_BASE_URL,
      ).toString(),
      deviceToken: this.tokens.issueDeviceToken(
        device.deviceId,
        device.tokenGeneration,
        device.issuedAt,
        device.expiresAt,
      ),
      webhookSecret: this.tokens.webhookSecret(),
      sessionIds,
    };
  }

  @Post('events/claim')
  @HttpCode(200)
  async claim(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ) {
    const device = await this.authenticate(authorization);
    const parsed = eventInboxClaimSchema.safeParse(body);
    if (!parsed.success) throw new UnprocessableEntityException('Invalid Event Inbox claim request');
    const deadline = Date.now() + parsed.data.waitSeconds * 1000;
    for (;;) {
      const data = await this.repository.claim(
        device.deviceId,
        device.tokenGeneration,
        device.sessionIds,
        parsed.data.limit,
      );
      if (data.length > 0 || Date.now() >= deadline) return { data };
      await new Promise(resolve => setTimeout(resolve, Math.min(500, deadline - Date.now())));
    }
  }

  @Post('events/ack')
  @HttpCode(200)
  async acknowledge(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ) {
    const device = await this.authenticate(authorization);
    const parsed = eventInboxAckSchema.safeParse(body);
    if (!parsed.success) throw new UnprocessableEntityException('Invalid Event Inbox acknowledgement');
    const receipts = parsed.data.receiptHandles.map(decodeEventInboxReceipt);
    if (receipts.some(receipt => receipt === null)) {
      throw new UnprocessableEntityException('Invalid Event Inbox receipt handle');
    }
    return {
      acknowledged: await this.repository.acknowledge(
        device.deviceId,
        device.tokenGeneration,
        receipts as Exclude<typeof receipts[number], null>[],
      ),
    };
  }

  @Post('events/nack')
  @HttpCode(200)
  async negativelyAcknowledge(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ) {
    const device = await this.authenticate(authorization);
    const parsed = eventInboxNackSchema.safeParse(body);
    if (!parsed.success) throw new UnprocessableEntityException('Invalid Event Inbox negative acknowledgement');
    const items = parsed.data.items.map(item => ({ ...item, receipt: decodeEventInboxReceipt(item.receiptHandle) }));
    if (items.some(item => item.receipt === null)) {
      throw new UnprocessableEntityException('Invalid Event Inbox receipt handle');
    }
    return this.repository.negativelyAcknowledge(
      device.deviceId,
      device.tokenGeneration,
      items.map(item => ({ ...item, ...item.receipt! })),
    );
  }

  @Post('devices/revoke')
  @HttpCode(200)
  async revoke(@Headers('authorization') authorization: string | undefined) {
    const device = await this.authenticateForRetirement(authorization);
    return {
      revoked: await this.devices.revoke(device.deviceId, device.tokenGeneration),
    };
  }

  private async authenticate(
    authorization: string | undefined,
  ): Promise<EventInboxDeviceAuthorization> {
    const claims = this.tokens.authenticate(authorization);
    const device = await this.devices.authorize(claims);
    if (!device) throw new UnauthorizedException('Invalid Event Inbox device token');
    return device;
  }

  private async authenticateForRetirement(
    authorization: string | undefined,
  ): Promise<EventInboxDeviceAuthorization> {
    const claims = this.tokens.authenticate(authorization);
    const device = await this.devices.authorizeRetirement(claims);
    if (!device) throw new UnauthorizedException('Invalid Event Inbox device token');
    return device;
  }
}

@Controller('health')
export class EventInboxHealthController {
  constructor(private readonly repository: EventInboxRepository) {}

  @Get('live')
  live() {
    return { status: 'ok', service: 'wa-event-inbox', protocolVersion: 2 };
  }

  @Get('ready')
  async ready() {
    const readiness = await this.repository.readiness();
    return {
      status: 'ready',
      service: 'wa-event-inbox',
      protocolVersion: 2,
      release: {
        runtimeVersion: RUNTIME_VERSION,
        openwaReleaseTag: OPENWA_RELEASE_TAG,
        connectorProtocolVersion: OPENWA_CONNECTOR_PROTOCOL_VERSION,
        connectorJournalSchemaVersion: OPENWA_CONNECTOR_JOURNAL_SCHEMA_VERSION,
        migrationHead: readiness.migrationHead,
        migrationCount: readiness.migrationCount,
      },
      ...readiness,
    };
  }
}
