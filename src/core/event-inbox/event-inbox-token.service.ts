import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { secureStringEqual } from '../security/secure-string-equal';
import { EVENT_INBOX_CONFIG } from './event-inbox-config.module';
import { eventInboxConfig, type EventInboxConfig } from './event-inbox-config';

const deviceClaimsSchema = z.object({
  version: z.literal(1),
  deviceId: z.uuid(),
  sessionIds: z.array(z.uuid()).min(1).max(1000),
});

export type EventInboxDeviceClaims = z.infer<typeof deviceClaimsSchema>;

@Injectable()
export class EventInboxTokenService {
  constructor(
    @Inject(EVENT_INBOX_CONFIG) private readonly config: EventInboxConfig = eventInboxConfig(),
  ) {}

  webhookSecret(): string {
    return this.sign('openwa-webhook-secret:v1');
  }

  issueDeviceToken(deviceId: string, sessionIds: string[]): string {
    const payload = Buffer.from(JSON.stringify({ version: 1, deviceId, sessionIds }), 'utf8')
      .toString('base64url');
    return `${payload}.${this.sign(`device-token:v1:${payload}`)}`;
  }

  authenticate(authorization: string | undefined): EventInboxDeviceClaims {
    const supplied = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : undefined;
    if (!supplied || supplied.length > 4096) throw this.unauthorized();
    const [payload, signature, extra] = supplied.split('.');
    if (!payload || !signature || extra
      || !secureStringEqual(signature, this.sign(`device-token:v1:${payload}`))) {
      throw this.unauthorized();
    }
    try {
      const parsed = deviceClaimsSchema.safeParse(
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
