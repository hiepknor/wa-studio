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

describe('health OpenAPI contract', () => {
  it('publishes process degradation separately from dependency readiness', () => {
    const operation = contract.paths['/api/v1/health/ready']?.get;
    expect(operation?.responses['200']?.content?.['application/json']?.schema)
      .toEqual({ $ref: '#/components/schemas/HealthReadyDto' });
    expect(operation?.responses['503']?.content?.['application/json']?.schema)
      .toEqual({ $ref: '#/components/schemas/HealthNotReadyDto' });
    expect(operation?.security).toEqual([{ 'runtime-key': [] }]);
    expect(contract.paths['/api/v1/health/live']?.get?.security).toBeUndefined();

    const ready = contract.components.schemas.HealthReadyDto!;
    expect(ready.required).toEqual([
      'status', 'dependencies', 'processes', 'liveSendsEnabled',
      'openwaRelease', 'allowedSessionCount',
    ]);
    expect(contract.components.schemas.RuntimeProcessHealthDto?.properties).toMatchObject({
      worker: { enum: ['healthy', 'degraded'] },
      scheduler: { enum: ['healthy', 'degraded'] },
    });
    expect(contract.components.schemas.HealthQueueDependencyDto?.properties).toMatchObject({
      backend: { enum: ['redis', 'postgres'] },
      ready: { enum: [true] },
    });
  });

  it('publishes the instance-scoped operational gate used by the desktop supervisor', () => {
    const operation = contract.paths['/api/v1/health/operational']?.get;
    expect(operation?.responses['200']?.content?.['application/json']?.schema)
      .toEqual({ $ref: '#/components/schemas/HealthOperationalDto' });
    expect(operation?.responses['503']?.content?.['application/json']?.schema)
      .toEqual({ $ref: '#/components/schemas/HealthOperationalDto' });

    const operational = contract.components.schemas.HealthOperationalDto!;
    expect(operational.required).toEqual([
      'status', 'service', 'version', 'instanceId', 'dependencies', 'processes',
    ]);
    expect(operational.properties).toMatchObject({
      status: { enum: ['operational', 'degraded'] },
      instanceId: { type: 'string' },
      dependencies: { nullable: true },
      reason: { enum: ['dependency_unavailable', 'background_process_degraded'] },
    });
  });
});
