import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { ActivityQueryDto } from '../../contracts/activity/activity-query.dto';
import { runtimeConfig, type RuntimeConfig } from '../../core/config/runtime-config';
import { RUNTIME_CONFIG } from '../../core/config/runtime-config.module';
import { decodeActivityCursor, encodeActivityCursor } from './activity-cursor';
import { ActivityRepository } from './activity.repository';

@Injectable()
export class ActivityService {
  constructor(
    private readonly repository: ActivityRepository,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig(),
  ) {}

  async get(sessionId: string, id: string) {
    this.assertSessionVisible(sessionId);
    const event = await this.repository.find(sessionId, id);
    if (!event) throw new NotFoundException('Activity event not found');
    return event;
  }

  async list(query: ActivityQueryDto) {
    this.assertSessionVisible(query.sessionId);
    const cursor = query.cursor ? decodeActivityCursor(query.cursor) : undefined;
    if (query.cursor && !cursor) throw new BadRequestException('cursor is invalid');
    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;
    if (from && to && from >= to) throw new BadRequestException('from must be earlier than to');
    const result = await this.repository.list({
      sessionId: query.sessionId,
      query: query.query,
      categories: query.category,
      severities: query.severity,
      from,
      to,
      cursor: cursor ?? undefined,
      limit: query.limit,
    });
    const last = result.data[result.data.length - 1];
    return {
      data: result.data,
      meta: {
        limit: query.limit,
        nextCursor: result.hasMore && last
          ? encodeActivityCursor({ occurredAt: new Date(last.occurredAt), id: last.id })
          : null,
        retentionDays: this.config.RUNTIME_ACTIVITY_RETENTION_DAYS,
      },
    };
  }

  private assertSessionVisible(sessionId: string): void {
    if (!this.config.OPENWA_ALLOWED_SESSION_IDS.includes(sessionId)) {
      throw new NotFoundException('Session not found');
    }
  }
}
