import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  PayloadTooLargeException,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import {
  eventInboxAckSchema,
  eventInboxClaimSchema,
  eventInboxNackSchema,
  eventInboxPairingRequestSchema,
} from '../../contracts/event-inbox';
import { EVENT_INBOX_CONFIG } from '../../core/event-inbox/event-inbox-config.module';
import { eventInboxConfig, type EventInboxConfig } from '../../core/event-inbox/event-inbox-config';
import { EventInboxTokenService } from '../../core/event-inbox/event-inbox-token.service';
import { verifySha256Hmac } from '../../core/security/hmac-signature';
import { EventInboxOpenWAClient } from '../../integrations/openwa/event-inbox-openwa.client';
import {
  EventInboxDeviceRepository,
  type EventInboxDeviceAuthorization,
} from './event-inbox-device.repository';
import { decodeEventInboxReceipt } from './event-inbox-receipt';
import { EventInboxRepository } from './event-inbox.repository';

const envelopeSchema = z.object({
  event: z.string().min(1).max(256),
  timestamp: z.string().min(1).max(128),
  sessionId: z.uuid(),
  idempotencyKey: z.string().min(1).max(512),
  deliveryId: z.string().min(1).max(512),
  data: z.record(z.string(), z.unknown()),
}).passthrough();

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
    const parsed = envelopeSchema.safeParse(request.body);
    if (!parsed.success || !this.allowedSessions.has(parsed.data.sessionId)) {
      throw new UnprocessableEntityException('Invalid or disallowed OpenWA webhook envelope');
    }
    const result = await this.repository.insert(request.rawBody, signature!, parsed.data);
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
    @Inject(EVENT_INBOX_CONFIG) private readonly config: EventInboxConfig = eventInboxConfig(),
  ) {}

  @Post('pair')
  @HttpCode(200)
  async pair(@Body() body: unknown) {
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
    const device = await this.authenticate(authorization);
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
    return {
      status: 'ready',
      service: 'wa-event-inbox',
      protocolVersion: 2,
      ...await this.repository.readiness(),
    };
  }
}
