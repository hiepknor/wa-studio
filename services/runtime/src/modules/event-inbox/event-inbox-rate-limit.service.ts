import { Inject, Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { EVENT_INBOX_CONFIG } from '../../core/event-inbox/event-inbox-config.module';
import { eventInboxConfig, type EventInboxConfig } from '../../core/event-inbox/event-inbox-config';
import { EventInboxRepository } from './event-inbox.repository';

export interface EventInboxRateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

@Injectable()
export class EventInboxPairRateLimitService {
  constructor(
    private readonly repository: EventInboxRepository,
    @Inject(EVENT_INBOX_CONFIG) private readonly config: EventInboxConfig = eventInboxConfig(),
  ) {}

  async consume(sourceIp: string): Promise<EventInboxRateLimitDecision> {
    const global = await this.repository.consumeRateLimit(
      'pair-global',
      this.hash('global'),
      this.config.EVENT_INBOX_PAIR_GLOBAL_RATE_LIMIT_MAX_ATTEMPTS,
      this.config.EVENT_INBOX_PAIR_RATE_LIMIT_WINDOW_SECONDS,
    );
    if (!global.allowed) return global;

    return this.repository.consumeRateLimit(
      'pair-ip',
      this.hash(this.normalizeSourceIp(sourceIp)),
      this.config.EVENT_INBOX_PAIR_RATE_LIMIT_MAX_ATTEMPTS,
      this.config.EVENT_INBOX_PAIR_RATE_LIMIT_WINDOW_SECONDS,
    );
  }

  private hash(value: string): Buffer {
    return createHmac('sha256', this.config.EVENT_INBOX_MASTER_SECRET)
      .update('event-inbox:pair-rate-limit:v1\0')
      .update(value)
      .digest();
  }

  private normalizeSourceIp(sourceIp: string): string {
    const normalized = sourceIp.trim().toLowerCase();
    return normalized.length > 0 ? normalized.slice(0, 128) : 'unknown';
  }
}
