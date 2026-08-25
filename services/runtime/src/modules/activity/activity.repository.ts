import { Injectable } from '@nestjs/common';
import type {
  ActivityCategory,
  ActivityEventDto,
  ActivityOrigin,
  ActivitySeverity,
} from '../../contracts/activity/activity.dto';
import { DatabaseService } from '../../core/database/database.service';
import type { ActivityCursor } from './activity-cursor';

interface ActivityEventRow {
  id: string;
  session_id: string;
  event_type: string;
  event_version: number;
  category: ActivityCategory;
  severity: ActivitySeverity;
  origin: ActivityOrigin;
  subject_type: string;
  subject_id: string;
  subject_label_snapshot: string;
  campaign_id: string | null;
  run_id: string | null;
  sync_run_id: string | null;
  group_id: string | null;
  correlation_id: string | null;
  metadata: Record<string, unknown>;
  occurred_at: Date;
}

const mapActivityEvent = (row: ActivityEventRow): ActivityEventDto => ({
  id: row.id,
  sessionId: row.session_id,
  eventType: row.event_type,
  eventVersion: row.event_version,
  category: row.category,
  severity: row.severity,
  origin: row.origin,
  subject: {
    type: row.subject_type,
    id: row.subject_id,
    labelSnapshot: row.subject_label_snapshot,
  },
  related: {
    campaignId: row.campaign_id,
    runId: row.run_id,
    syncRunId: row.sync_run_id,
    groupId: row.group_id,
  },
  correlationId: row.correlation_id,
  metadata: row.metadata,
  occurredAt: row.occurred_at,
});

@Injectable()
export class ActivityRepository {
  constructor(private readonly database: DatabaseService) {}

  async list(input: {
    sessionId: string;
    query?: string;
    categories?: ActivityCategory[];
    severities?: ActivitySeverity[];
    from?: Date;
    to?: Date;
    cursor?: ActivityCursor;
    limit: number;
  }): Promise<{ data: ActivityEventDto[]; hasMore: boolean }> {
    const normalizedQuery = input.query?.trim();
    const searchPattern = normalizedQuery
      ? `%${normalizedQuery.replace(/[\\%_]/g, '\\$&')}%`
      : null;
    const categories = input.categories?.length ? input.categories : null;
    const severities = input.severities?.length ? input.severities : null;
    const result = await this.database.query<ActivityEventRow>(
      `SELECT id, session_id, event_type, event_version, category, severity, origin,
         subject_type, subject_id, subject_label_snapshot, campaign_id, run_id,
         sync_run_id, group_id, correlation_id, metadata, occurred_at
       FROM activity_events
       WHERE session_id = $1
         AND ($2::text IS NULL OR subject_label_snapshot ILIKE $2 ESCAPE '\\'
           OR subject_id ILIKE $2 ESCAPE '\\' OR correlation_id ILIKE $2 ESCAPE '\\'
           OR event_type ILIKE $2 ESCAPE '\\')
         AND ($3::text[] IS NULL OR category = ANY($3))
         AND ($4::text[] IS NULL OR severity = ANY($4))
         AND ($5::timestamptz IS NULL OR occurred_at >= $5)
         AND ($6::timestamptz IS NULL OR occurred_at < $6)
         AND ($7::timestamptz IS NULL OR (occurred_at, id) < ($7, $8::uuid))
       ORDER BY occurred_at DESC, id DESC
       LIMIT $9`,
      [
        input.sessionId,
        searchPattern,
        categories,
        severities,
        input.from ?? null,
        input.to ?? null,
        input.cursor?.occurredAt ?? null,
        input.cursor?.id ?? null,
        input.limit + 1,
      ],
    );
    return {
      data: result.rows.slice(0, input.limit).map(mapActivityEvent),
      hasMore: result.rows.length > input.limit,
    };
  }
}
