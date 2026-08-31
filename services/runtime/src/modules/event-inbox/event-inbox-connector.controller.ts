import {
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Put,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  EVENT_INBOX_CONNECTOR_PROTOCOL_VERSION,
  eventInboxConnectorBindingSchema,
  eventInboxConnectorEventSchema,
  eventInboxConnectorHeartbeatSchema,
  eventInboxConnectorIdentitySchema,
  eventInboxConnectorGenerationSchema,
  eventInboxPreparedConnectorCredentialSchema,
  eventInboxConnectorProvisionSchema,
} from '../../contracts/event-inbox';
import { openWAConnectorEvidenceSchema } from '../../contracts/openwa-connector';
import { EventInboxTokenService } from '../../core/event-inbox/event-inbox-token.service';
import { signSha256Hmac } from '../../core/security/hmac-signature';
import { EventInboxConnectorRepository } from './event-inbox-connector.repository';
import {
  EventInboxDeviceRepository,
  type EventInboxDeviceAuthorization,
} from './event-inbox-device.repository';
import { EventInboxRepository, type EventInboxInsertResult } from './event-inbox.repository';

@Controller('event-inbox/connectors')
export class EventInboxConnectorController {
  constructor(
    private readonly connectors: EventInboxConnectorRepository,
    private readonly events: EventInboxRepository,
    private readonly tokens: EventInboxTokenService,
    private readonly devices: EventInboxDeviceRepository,
  ) {}

  @Post('provision')
  @HttpCode(200)
  async provision(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ) {
    const device = await this.authenticateDevice(authorization);
    const parsed = eventInboxConnectorProvisionSchema.safeParse(body);
    if (!parsed.success) throw new UnprocessableEntityException('Invalid connector provisioning request');
    return {
      protocolVersion: EVENT_INBOX_CONNECTOR_PROTOCOL_VERSION,
      ...await this.connectors.provision(device, parsed.data.sessionIds),
    };
  }

  @Put('credentials/:connectorId/generations/:generation')
  async putPreparedCredential(
    @Headers('authorization') authorization: string | undefined,
    @Param('connectorId') connectorId: string,
    @Param('generation') generation: string,
    @Body() body: unknown,
  ) {
    const device = await this.authenticateDevice(authorization);
    const parsedIdentity = eventInboxConnectorIdentitySchema.safeParse({ connectorId });
    const parsedGeneration = eventInboxConnectorGenerationSchema.safeParse(generation);
    const parsed = eventInboxPreparedConnectorCredentialSchema.safeParse(body);
    if (!parsedIdentity.success || !parsedGeneration.success || !parsed.success) {
      throw new UnprocessableEntityException('Invalid prepared connector credential');
    }
    return {
      protocolVersion: EVENT_INBOX_CONNECTOR_PROTOCOL_VERSION,
      ...await this.connectors.putPreparedCredential(
        device,
        parsedIdentity.data.connectorId,
        parsedGeneration.data,
        parsed.data.secretSha256,
        parsed.data.sessionIds,
      ),
    };
  }

  @Post('rotate')
  @HttpCode(200)
  async rotate(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ) {
    const device = await this.authenticateDevice(authorization);
    const parsed = eventInboxConnectorIdentitySchema.safeParse(body);
    if (!parsed.success) throw new UnprocessableEntityException('Invalid connector rotation request');
    const credential = await this.connectors.rotate(device, parsed.data.connectorId);
    if (!credential) throw new UnauthorizedException('Connector is not owned by this device');
    return { protocolVersion: EVENT_INBOX_CONNECTOR_PROTOCOL_VERSION, ...credential };
  }

  @Post('revoke')
  @HttpCode(200)
  async revoke(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ) {
    const device = await this.authenticateDeviceForRetirement(authorization);
    const parsed = eventInboxConnectorIdentitySchema.safeParse(body);
    if (!parsed.success) throw new UnprocessableEntityException('Invalid connector revocation request');
    return { revoked: await this.connectors.revoke(device, parsed.data.connectorId) };
  }

  @Put('bindings/:sessionId')
  async setBinding(
    @Headers('authorization') authorization: string | undefined,
    @Param('sessionId') sessionId: string,
    @Body() body: unknown,
  ) {
    const device = await this.authenticateDevice(authorization);
    const parsed = eventInboxConnectorBindingSchema.safeParse(body);
    if (!parsed.success) throw new UnprocessableEntityException('Invalid connector binding');
    return this.connectors.setBinding(
      device,
      sessionId,
      parsed.data.connectorId,
      parsed.data.webhookId,
      parsed.data.generation,
    );
  }

  @Get('status')
  async status(@Headers('authorization') authorization: string | undefined) {
    const device = await this.authenticateDevice(authorization);
    return {
      protocolVersion: EVENT_INBOX_CONNECTOR_PROTOCOL_VERSION,
      generatedAt: new Date().toISOString(),
      sessions: await this.connectors.status(device),
    };
  }

  @Post('heartbeat')
  @HttpCode(200)
  async heartbeat(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ) {
    const connector = await this.connectors.authenticate(authorization);
    const parsed = eventInboxConnectorHeartbeatSchema.safeParse(body);
    if (!parsed.success) throw new UnprocessableEntityException('Invalid connector heartbeat');
    return {
      protocolVersion: EVENT_INBOX_CONNECTOR_PROTOCOL_VERSION,
      serverTime: new Date().toISOString(),
      bindings: await this.connectors.recordHeartbeat(connector, parsed.data),
    };
  }

  @Post('events')
  @HttpCode(200)
  async receiveEvent(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ) {
    const connector = await this.connectors.authenticate(authorization);
    const parsed = eventInboxConnectorEventSchema.safeParse(body);
    if (!parsed.success) throw new UnprocessableEntityException('Invalid connector event');
    let envelope = parsed.data.envelope;
    if (envelope.event === 'wa-studio.connector.evidence') {
      const evidence = openWAConnectorEvidenceSchema.safeParse(envelope.data);
      if (!evidence.success) throw new UnprocessableEntityException('Invalid connector delivery evidence');
      if (evidence.data.sessionId !== envelope.sessionId
        || envelope.deliveryId !== evidence.data.eventId
        || !envelope.idempotencyKey.startsWith(`${evidence.data.eventId}_`)) {
        throw new ConflictException('Connector delivery evidence identity does not match its envelope');
      }
      envelope = { ...envelope, data: evidence.data };
    }
    if (!await this.connectors.authorizeDelivery(
      connector,
      envelope.sessionId,
      parsed.data.bindingGeneration,
      envelope.deliveryId,
      envelope.idempotencyKey,
    )) {
      throw new ConflictException('Connector event does not match an authorized connector binding generation');
    }
    const rawBody = Buffer.from(JSON.stringify(envelope), 'utf8');
    const signature = signSha256Hmac(rawBody, this.tokens.webhookSecret());
    const result = await this.events.insert(rawBody, signature, envelope);
    this.assertAccepted(result);
    return { accepted: true, duplicate: result === 'duplicate' };
  }

  private async authenticateDevice(
    authorization: string | undefined,
  ): Promise<EventInboxDeviceAuthorization> {
    const claims = this.tokens.authenticate(authorization);
    const device = await this.devices.authorize(claims);
    if (!device) throw new UnauthorizedException('Invalid Event Inbox device token');
    return device;
  }

  private async authenticateDeviceForRetirement(
    authorization: string | undefined,
  ): Promise<EventInboxDeviceAuthorization> {
    const claims = this.tokens.authenticate(authorization);
    const device = await this.devices.authorizeRetirement(claims);
    if (!device) throw new UnauthorizedException('Invalid Event Inbox device token');
    return device;
  }

  private assertAccepted(result: EventInboxInsertResult): void {
    if (result === 'conflict') {
      throw new ConflictException('Connector event idempotency key conflicts with a different payload');
    }
    if (result === 'capacity') {
      throw new ServiceUnavailableException('Event Inbox storage capacity is exhausted');
    }
  }
}
