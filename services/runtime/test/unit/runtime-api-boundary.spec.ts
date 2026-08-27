import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('Runtime API deployment boundary', () => {
  it('builds the workspace-aware image from the monorepo root', () => {
    const compose = source('docker-compose.yml');
    expect(compose).toContain('context: ../..');
    expect(compose).toContain('dockerfile: services/runtime/Dockerfile');
  });

  it('pins stateful dependency images and authenticates detailed readiness probes', () => {
    const compose = source('docker-compose.yml');
    expect(compose).toMatch(/image: postgres:17\.11-alpine3\.24@sha256:[0-9a-f]{64}/u);
    expect(compose).toMatch(/image: redis:8\.10\.1-alpine3\.23@sha256:[0-9a-f]{64}/u);
    expect(compose).toContain("'X-Runtime-Key':process.env.RUNTIME_API_KEY");
    expect(compose).not.toMatch(/image: (?:postgres|redis):[^\s@]+\s*$/mu);
  });
});
