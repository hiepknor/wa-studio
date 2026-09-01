import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { secureStringEqual } from '../security/secure-string-equal';
import { EVENT_INBOX_CONFIG } from './event-inbox-config.module';
import { eventInboxConfig, type EventInboxConfig } from './event-inbox-config';

const legacyDeviceClaimsSchema = z.object({
  version: z.literal(1),
  deviceId: z.uuid(),
  sessionIds: z.array(z.uuid()).min(1).max(1000),
});

const deviceClaimsV2Schema = z.object({
  version: z.literal(2),
  deviceId: z.uuid(),
  tokenGeneration: z.number().int().positive().safe(),
  issuedAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
});

export type EventInboxLegacyDeviceClaims = z.infer<typeof legacyDeviceClaimsSchema>;
export type EventInboxDeviceClaimsV2 = z.infer<typeof deviceClaimsV2Schema>;
export type EventInboxDeviceClaims = EventInboxLegacyDeviceClaims | EventInboxDeviceClaimsV2;

@Injectable()
export class EventInboxTokenService {
  constructor(
    @Inject(EVENT_INBOX_CONFIG) private readonly config: EventInboxConfig = eventInboxConfig(),
  ) {}

  webhookSecret(): string {
    return this.sign('openwa-webhook-secret:v1');
  }

  issueDeviceToken(
    deviceId: string,
    tokenGeneration: number,
    issuedAt: Date,
    expiresAt: Date,
  ): string {
    const payload = Buffer.from(JSON.stringify({
      version: 2,
      deviceId,
      tokenGeneration,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    }), 'utf8')
      .toString('base64url');
    return `v2.${payload}.${this.sign(`device-token:v2:${payload}`)}`;
  }

  authenticate(authorization: string | undefined): EventInboxDeviceClaims {
    const supplied = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : undefined;
    if (!supplied || supplied.length > 4096) throw this.unauthorized();
    if (supplied.startsWith('v2.')) return this.authenticateV2(supplied);
    return this.authenticateLegacy(supplied);
  }

  private authenticateV2(supplied: string): EventInboxDeviceClaimsV2 {
    const [prefix, payload, signature, extra] = supplied.split('.');
    if (prefix !== 'v2' || !payload || !signature || extra
      || !secureStringEqual(signature, this.sign(`device-token:v2:${payload}`))) {
      throw this.unauthorized();
    }
    try {
      const parsed = deviceClaimsV2Schema.safeParse(
        JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
      );
      if (!parsed.success || Date.parse(parsed.data.expiresAt) <= Date.now()
        || Date.parse(parsed.data.issuedAt) > Date.now() + 60_000
        || Date.parse(parsed.data.expiresAt) <= Date.parse(parsed.data.issuedAt)) {
        throw this.unauthorized();
      }
      return parsed.data;
    } catch {
      throw this.unauthorized();
    }
  }

  private authenticateLegacy(supplied: string): EventInboxLegacyDeviceClaims {
    const acceptUntil = this.config.EVENT_INBOX_V1_ACCEPT_UNTIL;
    if (!acceptUntil || Date.parse(acceptUntil) <= Date.now()) throw this.unauthorized();
    const [payload, signature, extra] = supplied.split('.');
    if (!payload || !signature || extra
      || !secureStringEqual(signature, this.sign(`device-token:v1:${payload}`))) {
      throw this.unauthorized();
    }
    try {
      const parsed = legacyDeviceClaimsSchema.safeParse(
        JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
      );
      if (!parsed.success) throw this.unauthorized();
      return parsed.data;
    } catch {
      throw this.unauthorized();
    }
  }

  private sign(value: string): string {
    return createHmac('sha256', this.config.EVENT_INBOX_MASTER_SECRET)
      .update(value)
      .digest('base64url');
  }

  private unauthorized(): UnauthorizedException {
    return new UnauthorizedException('Invalid Event Inbox device token');
  }
}
