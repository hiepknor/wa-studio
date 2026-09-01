import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../core/database/database.service';

export const STATE_REVISION_RESOURCES = [
  'sessions',
  'groups',
  'groupLists',
  'campaigns',
  'runs',
  'deliveries',
  'activity',
] as const;

export type StateRevisionResource = typeof STATE_REVISION_RESOURCES[number];
export type StateRevisionVector = Record<StateRevisionResource, number>;

@Injectable()
export class StateRevisionsRepository {
  constructor(private readonly database: DatabaseService) {}

  async read(sessionId: string | null, allowedSessionIds: string[]): Promise<StateRevisionVector> {
    const result = await this.database.query<{ resource: StateRevisionResource; revision: string }>(
      `SELECT resource, sum(revision)::text AS revision
       FROM runtime_resource_revisions
       WHERE (resource = 'sessions' AND session_id = ANY($2::text[]))
          OR ($1::text IS NOT NULL AND resource <> 'sessions' AND session_id = $1)
       GROUP BY resource`,
      [sessionId, allowedSessionIds],
    );
    const vector = Object.fromEntries(
      STATE_REVISION_RESOURCES.map(resource => [resource, 0]),
    ) as StateRevisionVector;
    result.rows.forEach(row => {
      if (STATE_REVISION_RESOURCES.includes(row.resource)) {
        vector[row.resource] = Number(row.revision);
      }
    });
    return vector;
  }
}
