import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const contract = JSON.parse(readFileSync(
  resolve(process.cwd(), '../../packages/runtime-contract/openapi.json'),
  'utf8',
)) as {
  components: { schemas: Record<string, Record<string, any>> };
  paths: Record<string, Record<string, Record<string, any>>>;
};

describe('activity OpenAPI contract', () => {
  it('publishes a bounded cursor timeline with explicit retention metadata', () => {
    const operation = contract.paths['/api/v1/activity']?.get;
    const parameters = new Map<string, Record<string, any>>(
      (operation?.parameters ?? []).map((parameter: Record<string, any>) => [parameter.name, parameter]),
    );
    expect(parameters.get('sessionId')).toMatchObject({ required: true, in: 'query' });
    expect(parameters.get('query')?.schema).toMatchObject({ type: 'string', maxLength: 200 });
    expect(parameters.get('category')).toMatchObject({ style: 'form', explode: false });
    expect(parameters.get('severity')).toMatchObject({ style: 'form', explode: false });
    expect(parameters.get('cursor')?.schema).toMatchObject({ type: 'string', maxLength: 512 });
    expect(parameters.get('limit')?.schema).toMatchObject({ minimum: 1, maximum: 200, default: 50 });
    expect(operation?.responses).toEqual(expect.objectContaining({
      200: expect.any(Object),
      400: expect.any(Object),
      404: expect.any(Object),
    }));
    expect(contract.components.schemas.ActivityPageMetaDto?.required).toEqual([
      'limit', 'nextCursor', 'retentionDays',
    ]);
  });

  it('keeps activity sanitized and cross-linkable without raw payload fields', () => {
    const event = contract.components.schemas.ActivityEventDto!;
    expect(event.required).toEqual(expect.arrayContaining([
      'id', 'sessionId', 'eventType', 'eventVersion', 'category', 'severity',
      'origin', 'subject', 'related', 'correlationId', 'metadata', 'occurredAt',
    ]));
    expect(event.properties).not.toHaveProperty('payload');
    expect(event.properties).not.toHaveProperty('body');
    expect(contract.components.schemas.ActivityRelatedDto?.properties).toEqual(expect.objectContaining({
      campaignId: expect.objectContaining({ nullable: true }),
      runId: expect.objectContaining({ nullable: true }),
      syncRunId: expect.objectContaining({ nullable: true }),
      groupId: expect.objectContaining({ nullable: true }),
    }));
  });
});
